/**
 * Pipeline MCP tool handlers — pure functions over store + auth context.
 * Wired into the Slack MCP server; unit-tested without HTTP.
 */

import type { PipelineRuntimeMode } from "../config.ts";
import { canWritePipelineArtifacts } from "../agents/capabilities.ts";
import type { SlackMcpRunContext } from "../mcp/context.ts";
import type { PipelineStore } from "./store/interface.ts";
import { projectRunSummary } from "./projection.ts";
import {
  parseAgentOutcome,
  registerPr,
  reportOutcome,
  requestHandoff,
  type OutcomeAuthContext,
} from "./outcomes.ts";
import { runPipelineCheck, writePipelineArtifact } from "./artifacts.ts";
import type { GitHubResourceRegistration, TransitionReceipt } from "./types.ts";

export type PipelineToolRuntime = {
  store: PipelineStore;
  runtimeMode: PipelineRuntimeMode;
  githubTrackingEnabled: boolean;
  /** Optional post-outcome hook (e.g. pump outbox). */
  onOutcomeCommitted?: (receipt: TransitionReceipt) => Promise<void>;
};

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(payload: unknown, isError = false): ToolTextResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function authFromContext(runContext: SlackMcpRunContext): OutcomeAuthContext {
  return {
    agent: runContext.agent,
    channelId: runContext.channel,
    threadId: runContext.threadId,
  };
}

function requireActive(
  runtime: PipelineToolRuntime,
  opts: { allowReadWhenOff?: boolean; allowShadowRecord?: boolean } = {},
): ToolTextResult | null {
  if (runtime.runtimeMode === "off") {
    if (opts.allowReadWhenOff) return null;
    return textResult(
      { ok: false, reason: "pipeline runtime disabled (PIPELINE_RUNTIME_MODE=off)" },
      true,
    );
  }
  if (runtime.runtimeMode === "shadow" && !opts.allowShadowRecord) {
    // Shadow records proposals only through explicitly allowlisted paths;
    // mutating MCP tools that would enqueue durable dispatch must not run.
    return textResult(
      {
        ok: false,
        reason:
          "pipeline runtime is in shadow mode; mutating tools are disabled (set PIPELINE_RUNTIME_MODE=active to dispatch)",
      },
      true,
    );
  }
  return null;
}

export async function pipelineGetState(
  runtime: PipelineToolRuntime,
  runContext: SlackMcpRunContext | null,
  args: { run_id?: string },
): Promise<ToolTextResult> {
  // Read allowed even when mode=off (returns empty/not-found).
  if (!runContext) {
    return textResult({ ok: false, reason: "MCP run context missing" }, true);
  }

  let run = args.run_id
    ? await runtime.store.getRun(args.run_id)
    : await runtime.store.getRunByThread(runContext.threadId);

  if (!run) {
    return textResult({
      ok: true,
      runtimeMode: runtime.runtimeMode,
      run: null,
      message:
        runtime.runtimeMode === "off"
          ? "pipeline runtime disabled; no active run"
          : "no pipeline run for this thread",
    });
  }

  if (run.channelId !== runContext.channel || run.threadId !== runContext.threadId) {
    return textResult(
      { ok: false, reason: "run does not match authenticated thread/channel" },
      true,
    );
  }

  const assignments = await runtime.store.listAssignments(run.id);
  const events = await runtime.store.listEvents(run.id);
  const outbox = await runtime.store.listOutbox(run.id);
  const latestOutcome =
    assignments.length > 0
      ? (
          await runtime.store.listOutcomes(
            assignments[assignments.length - 1]!.id,
          )
        ).at(-1) ?? null
      : null;
  const githubAssocs = await runtime.store.listPipelineGitHubResources(run.id, true);
  const summary = projectRunSummary(run, assignments, latestOutcome ?? null);

  return textResult({
    ok: true,
    runtimeMode: runtime.runtimeMode,
    summary,
    run,
    assignments,
    recentEvents: events.slice(-20),
    outbox,
    githubResources: githubAssocs,
  });
}

export async function pipelineReportOutcome(
  runtime: PipelineToolRuntime,
  runContext: SlackMcpRunContext | null,
  args: {
    outcome: unknown;
    to_phase?: string;
    idempotency_key?: string;
  },
): Promise<ToolTextResult> {
  // Shadow may record outcomes for comparison, but suppress dispatch via deps.
  const disabled = requireActive(runtime, { allowShadowRecord: true });
  if (disabled) return disabled;
  if (!runContext) {
    return textResult({ ok: false, reason: "MCP run context missing" }, true);
  }

  let outcome;
  try {
    outcome = parseAgentOutcome(args.outcome);
  } catch (err) {
    return textResult(
      {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      },
      true,
    );
  }

  const shadow = runtime.runtimeMode === "shadow";
  const receipt = await reportOutcome(
    {
      store: runtime.store,
      githubTrackingEnabled: runtime.githubTrackingEnabled,
      suppressDispatch: shadow,
    },
    {
      outcome,
      toPhase: args.to_phase,
      idempotencyKey: args.idempotency_key,
      auth: authFromContext(runContext),
    },
  );

  // Only pump/dispatch when runtime is fully active.
  if (
    !shadow &&
    (receipt.status === "accepted" ||
      receipt.status === "waiting" ||
      receipt.status === "escalated" ||
      receipt.status === "duplicate")
  ) {
    await runtime.onOutcomeCommitted?.(receipt);
  }

  return textResult({ ok: receipt.status !== "rejected", receipt });
}

export async function pipelineRequestHandoff(
  runtime: PipelineToolRuntime,
  runContext: SlackMcpRunContext | null,
  args: {
    assignment_id: string;
    expected_run_version: number;
    target_agent: string;
    objective: string;
    reason: string;
    progress_fingerprint: string;
    idempotency_key: string;
    evidence_refs?: string[];
    artifact_refs?: string[];
    acceptance_criteria?: string[];
    to_phase?: string;
    candidate_revision_digest?: string;
  },
): Promise<ToolTextResult> {
  const disabled = requireActive(runtime);
  if (disabled) return disabled;
  if (!runContext) {
    return textResult({ ok: false, reason: "MCP run context missing" }, true);
  }

  const receipt = await requestHandoff(
    {
      store: runtime.store,
      githubTrackingEnabled: runtime.githubTrackingEnabled,
    },
    {
      assignmentId: args.assignment_id,
      expectedRunVersion: args.expected_run_version,
      targetAgent: args.target_agent,
      objective: args.objective,
      reason: args.reason,
      progressFingerprint: args.progress_fingerprint,
      evidenceRefs: args.evidence_refs,
      artifactRefs: args.artifact_refs,
      acceptanceCriteria: args.acceptance_criteria,
      candidateRevisionDigest: args.candidate_revision_digest ?? null,
      idempotencyKey: args.idempotency_key,
      nextIdempotencyKey: `${args.idempotency_key}:next`,
      toPhase: args.to_phase,
      auth: authFromContext(runContext),
    },
  );

  if (receipt.status === "accepted" || receipt.status === "duplicate") {
    await runtime.onOutcomeCommitted?.(receipt);
  }

  return textResult({
    ok: receipt.status === "accepted" || receipt.status === "duplicate" || receipt.status === "buffered",
    receipt,
  });
}

export async function pipelineWriteArtifact(
  runtime: PipelineToolRuntime,
  runContext: SlackMcpRunContext | null,
  args: {
    run_id?: string;
    assignment_id?: string;
    path: string;
    content: string;
  },
): Promise<ToolTextResult> {
  const disabled = requireActive(runtime);
  if (disabled) return disabled;
  if (!runContext) {
    return textResult({ ok: false, reason: "MCP run context missing" }, true);
  }
  if (!canWritePipelineArtifacts(runContext.agent)) {
    return textResult(
      {
        ok: false,
        reason: `agent "${runContext.agent}" lacks pipeline-artifact-write capability`,
      },
      true,
    );
  }

  const run = args.run_id
    ? await runtime.store.getRun(args.run_id)
    : await runtime.store.getRunByThread(runContext.threadId);
  if (!run) {
    return textResult({ ok: false, reason: "run not found" }, true);
  }
  if (run.channelId !== runContext.channel || run.threadId !== runContext.threadId) {
    return textResult(
      { ok: false, reason: "run does not match authenticated thread/channel" },
      true,
    );
  }

  const assignment = args.assignment_id
    ? await runtime.store.getAssignment(args.assignment_id)
    : null;

  const result = await writePipelineArtifact({
    runId: run.id,
    relativePath: args.path,
    content: args.content,
    assignment,
  });

  if (!result.ok) {
    return textResult({ ok: false, reason: result.reason }, true);
  }
  return textResult({
    ok: true,
    path: result.path,
    artifactRef: result.artifactRef,
  });
}

export async function pipelineRegisterPr(
  runtime: PipelineToolRuntime,
  runContext: SlackMcpRunContext | null,
  args: {
    run_id: string;
    assignment_id: string;
    owner: string;
    repo: string;
    number: number;
    role: GitHubResourceRegistration["role"];
    workstream_key: string;
    attempt_id?: string | null;
    expected_head_sha: string;
  },
): Promise<ToolTextResult> {
  const disabled = requireActive(runtime);
  if (disabled) return disabled;
  if (!runContext) {
    return textResult({ ok: false, reason: "MCP run context missing" }, true);
  }

  const result = await registerPr(
    {
      store: runtime.store,
      githubTrackingEnabled: runtime.githubTrackingEnabled,
    },
    {
      runId: args.run_id,
      assignmentId: args.assignment_id,
      owner: args.owner,
      repo: args.repo,
      number: args.number,
      role: args.role,
      workstreamKey: args.workstream_key,
      attemptId: args.attempt_id ?? null,
      expectedHeadSha: args.expected_head_sha,
    },
    authFromContext(runContext),
  );

  if (!result.ok) {
    return textResult({ ok: false, reason: result.reason }, true);
  }
  return textResult({ ok: true, eventId: result.eventId });
}

export async function pipelineRunCheck(
  runtime: PipelineToolRuntime,
  runContext: SlackMcpRunContext | null,
  args: {
    run_id?: string;
    assignment_id: string;
    check_name: string;
    command?: string;
    status?: "passed" | "failed" | "skipped";
    stdout?: string;
    stderr?: string;
  },
): Promise<ToolTextResult> {
  const disabled = requireActive(runtime);
  if (disabled) return disabled;
  if (!runContext) {
    return textResult({ ok: false, reason: "MCP run context missing" }, true);
  }

  const assignment = await runtime.store.getAssignment(args.assignment_id);
  if (!assignment) {
    return textResult({ ok: false, reason: "assignment not found" }, true);
  }
  const run = args.run_id
    ? await runtime.store.getRun(args.run_id)
    : await runtime.store.getRun(assignment.runId);
  if (!run) {
    return textResult({ ok: false, reason: "run not found" }, true);
  }
  if (run.channelId !== runContext.channel || run.threadId !== runContext.threadId) {
    return textResult(
      { ok: false, reason: "run does not match authenticated thread/channel" },
      true,
    );
  }

  const result = await runPipelineCheck({
    runId: run.id,
    assignmentId: assignment.id,
    checkName: args.check_name,
    command: args.command,
    status: args.status,
    stdout: args.stdout,
    stderr: args.stderr,
  });

  if (!result.ok) {
    return textResult({ ok: false, reason: result.reason }, true);
  }
  return textResult({ ok: true, check: result.check });
}
