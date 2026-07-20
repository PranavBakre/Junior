/**
 * Pipeline MCP tool handlers — pure functions over store + auth context.
 * Wired into the Slack MCP server; unit-tested without HTTP.
 */

import type { PipelineRuntimeMode } from "../config.ts";
import {
  canEditProductCode,
  canWritePipelineArtifacts,
  checkCapability,
  isReadOnlyRole,
} from "../agents/capabilities.ts";
import {
  canonicalAgentName,
} from "../agents/registry.ts";
import {
  slackMcpAgentForSession,
  type SlackMcpRunContext,
} from "../mcp/context.ts";
import type { SessionStore } from "../session/store/interface.ts";
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
import type {
  Assignment,
  GitHubResourceRegistration,
  PipelineRun,
  TransitionReceipt,
} from "./types.ts";
import { createProductRun } from "./product/controller.ts";
import { createBugRun } from "./bug/controller.ts";
import type { BugMode } from "./bug/definition.ts";

export type PipelineToolRuntime = {
  store: PipelineStore;
  runtimeMode: PipelineRuntimeMode;
  githubTrackingEnabled: boolean;
  sessionStore?: SessionStore;
  productPipelineEnabled?: boolean;
  bugPipelineEnabled?: boolean;
  workspaceRoot?: string;
  /** Optional post-outcome hook (e.g. pump outbox). */
  onOutcomeCommitted?: (receipt: TransitionReceipt) => Promise<void>;
  /** Optional immediate wake after a new or recovered pipeline start. */
  onRunStarted?: (input: {
    runId: string;
    assignmentId: string;
  }) => Promise<void>;
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

export type PipelineStartRunArgs = {
  kind: "product" | "bug";
  start_kind: "pm" | "build" | "debug" | "reproducer";
  objective: string;
  reason: string;
  idempotency_key: string;
  repo_refs?: string[];
  acceptance_criteria?: string[];
  bug_mode?: BugMode;
};

/**
 * Deliberately promote the authenticated current Slack turn into a durable
 * pipeline. Text and keywords never enter this path on their own.
 */
export async function pipelineStartRun(
  runtime: PipelineToolRuntime,
  runContext: SlackMcpRunContext | null,
  args: PipelineStartRunArgs,
): Promise<ToolTextResult> {
  const disabled = requireActive(runtime);
  if (disabled) return disabled;
  if (!runContext?.signed) {
    return textResult({ ok: false, reason: "signed MCP run context required" }, true);
  }
  if (!runtime.sessionStore) {
    return textResult({ ok: false, reason: "pipeline session store unavailable" }, true);
  }

  const capability = checkCapability(runContext.agent, "pipeline-run-start");
  if (!capability.ok) {
    return textResult({ ok: false, reason: capability.reason }, true);
  }

  const productStart =
    args.kind === "product" &&
    (args.start_kind === "pm" || args.start_kind === "build");
  const bugStart =
    args.kind === "bug" &&
    (args.start_kind === "debug" || args.start_kind === "reproducer");
  if (!productStart && !bugStart) {
    return textResult(
      {
        ok: false,
        reason: `start_kind "${args.start_kind}" is invalid for ${args.kind} pipeline`,
      },
      true,
    );
  }
  if (args.kind === "product" && !runtime.productPipelineEnabled) {
    return textResult({ ok: false, reason: "product pipeline is disabled" }, true);
  }
  if (args.kind === "bug" && !runtime.bugPipelineEnabled) {
    return textResult({ ok: false, reason: "bug pipeline is disabled" }, true);
  }

  const session = await runtime.sessionStore.get(runContext.threadId);
  if (!session) {
    return textResult({ ok: false, reason: "thread session not found" }, true);
  }
  if (session.channel !== runContext.channel) {
    return textResult(
      { ok: false, reason: "session does not match authenticated channel" },
      true,
    );
  }
  const sessionAgent = slackMcpAgentForSession(session);
  if (sessionAgent !== runContext.agent) {
    return textResult(
      {
        ok: false,
        reason: `authenticated agent "${runContext.agent}" does not own the current session turn`,
      },
      true,
    );
  }
  const sourceMessageTs =
    session.activeTopLevelMessageTs ?? runContext.messageTs ?? null;
  if (!sourceMessageTs) {
    return textResult(
      { ok: false, reason: "authoritative source message timestamp missing" },
      true,
    );
  }

  const active = await runtime.store.getRunByThread(runContext.threadId);
  if (active && active.status !== "terminal" && active.kind !== args.kind) {
    return textResult(
      {
        ok: false,
        reason: `thread already has an active ${active.kind} pipeline`,
        activeRunId: active.id,
        activeKind: active.kind,
      },
      true,
    );
  }

  const repoRefs = [
    ...new Set([
      ...(session.targetRepo ? [session.targetRepo] : []),
      ...(args.repo_refs ?? []).map((repo) => repo.trim()).filter(Boolean),
    ]),
  ];
  const provenance = {
    actorType: "agent" as const,
    actorId: runContext.agent,
    reason: args.reason.trim(),
    idempotencyKey: `${runContext.threadId}:${sourceMessageTs}:${args.idempotency_key}`,
    sourceMessageTs,
  };

  try {
    const started = productStart
      ? await createProductRun(
          { store: runtime.store, workspaceRoot: runtime.workspaceRoot },
          {
            channelId: runContext.channel,
            threadId: runContext.threadId,
            objective: args.objective,
            startKind: args.start_kind as "pm" | "build",
            messageTs: sourceMessageTs,
            repoRefs,
            ownerAgent: runContext.agent,
            acceptanceCriteria: args.acceptance_criteria,
            provenance,
          },
        )
      : await createBugRun(
          { store: runtime.store, workspaceRoot: runtime.workspaceRoot },
          {
            channelId: runContext.channel,
            threadId: runContext.threadId,
            objective: args.objective,
            startKind: args.start_kind as "debug" | "reproducer",
            messageTs: sourceMessageTs,
            repoRefs,
            ownerAgent: runContext.agent,
            targetAgent:
              args.start_kind === "debug" ? runContext.agent : "reproducer",
            explicitMode: args.bug_mode,
            provenance,
          },
        );

    await runtime.sessionStore.mutateThread(runContext.threadId, (current) => {
      if (current.channel !== runContext.channel) {
        throw new Error("session channel changed during pipeline start");
      }
      current.activePipelineRunId = started.run.id;
      current.activePipelineKind = started.run.kind;
    });

    let wakeError: string | null = null;
    try {
      await runtime.onRunStarted?.({
        runId: started.run.id,
        assignmentId: started.assignment.id,
      });
    } catch (err) {
      wakeError = err instanceof Error ? err.message : String(err);
    }

    return textResult({
      ok: true,
      created: started.created,
      run: started.run,
      initialAssignment: started.assignment,
      dispatchQueued: true,
      wakeError,
    });
  } catch (err) {
    const winner = await runtime.store.getRunByThread(runContext.threadId);
    if (winner && winner.status !== "terminal" && winner.kind !== args.kind) {
      return textResult(
        {
          ok: false,
          reason: `thread already has an active ${winner.kind} pipeline`,
          activeRunId: winner.id,
          activeKind: winner.kind,
        },
        true,
      );
    }
    return textResult(
      { ok: false, reason: err instanceof Error ? err.message : String(err) },
      true,
    );
  }
}

/**
 * Caller may act on an assignment only if they own it (target) or are the
 * run's orchestrator owner. Read-only workers never get write/check tools
 * through the "orchestrator" path unless they truly own the assignment.
 */
function authorizeAssignmentAction(
  run: PipelineRun,
  assignment: Assignment,
  agent: string,
  opts: { requireWriteCapable?: boolean } = {},
): string | null {
  if (assignment.runId !== run.id) {
    return "assignment does not belong to run";
  }
  const caller = canonicalAgentName(agent) ?? agent.trim();
  const target =
    canonicalAgentName(assignment.targetAgent) ?? assignment.targetAgent;
  const owner =
    canonicalAgentName(run.ownerAgent) ?? run.ownerAgent;

  const ownsAssignment = caller === target;
  const isOrch =
    caller === owner ||
    caller === "lead" ||
    caller === "default" ||
    caller === "junior";

  if (!ownsAssignment && !isOrch) {
    return `agent "${agent}" is not authorized for assignment target "${assignment.targetAgent}"`;
  }

  if (opts.requireWriteCapable) {
    if (isReadOnlyRole(caller) && !ownsAssignment) {
      return `read-only agent "${agent}" cannot forge checks or write artifacts for another assignment`;
    }
    // Evidence/check recording is for builders/orchestrators, not pure reviewers.
    if (
      isReadOnlyRole(caller) &&
      !canEditProductCode(caller) &&
      caller !== "reproducer"
    ) {
      // Reproducer may write validation artifacts under its own assignment only.
      if (!(ownsAssignment && caller === "reproducer")) {
        return `agent "${agent}" lacks permission to record pipeline checks/artifacts`;
      }
    }
  }

  return null;
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

  // assignment_id is required so foreign artifactRefs cannot authorize escape.
  if (!args.assignment_id) {
    return textResult(
      { ok: false, reason: "assignment_id is required for pipeline_write_artifact" },
      true,
    );
  }
  const assignment = await runtime.store.getAssignment(args.assignment_id);
  if (!assignment) {
    return textResult({ ok: false, reason: "assignment not found" }, true);
  }
  const authFailure = authorizeAssignmentAction(
    run,
    assignment,
    runContext.agent,
    { requireWriteCapable: true },
  );
  if (authFailure) {
    return textResult({ ok: false, reason: authFailure }, true);
  }

  const result = await writePipelineArtifact({
    runId: run.id,
    relativePath: args.path,
    content: args.content,
    // Only use assignment refs for namespacing under the pipeline root — never
    // as a path escape hatch.
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

  // Assignment ownership + non-read-only: prevent review/reproducer (or any
  // thread peer) from forging passed typecheck/build/test evidence.
  const authFailure = authorizeAssignmentAction(
    run,
    assignment,
    runContext.agent,
    { requireWriteCapable: true },
  );
  if (authFailure) {
    return textResult({ ok: false, reason: authFailure }, true);
  }
  if (isReadOnlyRole(runContext.agent) && !canEditProductCode(runContext.agent)) {
    return textResult(
      {
        ok: false,
        reason: `agent "${runContext.agent}" cannot record pipeline_run_check evidence`,
      },
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
