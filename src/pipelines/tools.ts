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
import { canDispatch } from "../support/agents.ts";
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
  AgentOutcome,
  Assignment,
  GitHubResourceRegistration,
  PipelineRun,
  TransitionReceipt,
} from "./types.ts";
import {
  createProductRun,
  reduceProductOutcome,
} from "./product/controller.ts";
import { createBugRun, reduceBugOutcome } from "./bug/controller.ts";
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
  required_workstreams?: Array<"backend" | "frontend">;
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

  const active = session.activeRunId
    ? await runtime.store.getRun(session.activeRunId)
    : await runtime.store.getRunByThread(runContext.threadId);
  if (
    active &&
    active.status !== "terminal" &&
    active.kind !== "default" &&
    active.kind !== args.kind
  ) {
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
  if (active?.kind === "default" && active.status !== "terminal") {
    const invocation =
      runContext.agent === "default" || runContext.agent === "lead"
        ? session.activePipelineInvocation
        : session.agentSessions?.[runContext.agent]?.activePipelineInvocation;
    if (!invocation || invocation.runId !== active.id) {
      return textResult(
        {
          ok: false,
          reason: "pipeline promotion requires ownership of the active default assignment",
        },
        true,
      );
    }
    if (
      runContext.runId !== invocation.runId ||
      runContext.assignmentId !== invocation.assignmentId ||
      runContext.dispatchKey !== invocation.dispatchKey
    ) {
      return textResult(
        { ok: false, reason: "stale signed assignment context cannot promote the run" },
        true,
      );
    }
    const source = await runtime.store.getAssignment(invocation.assignmentId);
    if (!source || source.runId !== active.id) {
      return textResult(
        { ok: false, reason: "active default assignment is missing" },
        true,
      );
    }
    const caller = canonicalAgentName(runContext.agent) ?? runContext.agent;
    const target = canonicalAgentName(source.targetAgent) ?? source.targetAgent;
    if (caller !== target) {
      return textResult(
        { ok: false, reason: "authenticated agent does not own the active default assignment" },
        true,
      );
    }
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
  const exactSourceAssignmentId = active?.kind === "default"
    ? (runContext.agent === "default" || runContext.agent === "lead"
        ? session.activePipelineInvocation?.assignmentId
        : session.agentSessions?.[runContext.agent]?.activePipelineInvocation
          ?.assignmentId)
    : undefined;

  if (active && active.kind === args.kind && active.status !== "terminal") {
    const priorStart = (await runtime.store.listEvents(active.id)).find(
      (event) => event.idempotencyKey === `pipeline.promoted:${provenance.idempotencyKey}`,
    );
    if (priorStart?.assignmentId) {
      const priorAssignment = await runtime.store.getAssignment(priorStart.assignmentId);
      if (priorAssignment) {
        await runtime.store.enqueueOutbox({
          id: crypto.randomUUID(),
          runId: active.id,
          assignmentId: priorAssignment.id,
          eventType: "assignment.dispatch",
          payload: {
            assignmentId: priorAssignment.id,
            targetAgent: priorAssignment.targetAgent,
            startKind: args.start_kind,
            phase: active.phase,
          },
          idempotencyKey:
            `${active.kind}-dispatch:${priorAssignment.idempotencyKey}`,
        });
        await runtime.sessionStore.mutateThread(runContext.threadId, (current) => {
          current.activePipelineRunId = active.id;
          current.activePipelineKind = active.kind;
          current.activeRunId = active.id;
        });
        await runtime.onRunStarted?.({
          runId: active.id,
          assignmentId: priorAssignment.id,
        });
        return textResult({
          ok: true,
          created: false,
          promoted: priorStart.payload.fromKind === "default",
          run: active,
          initialAssignment: priorAssignment,
          dispatchQueued: true,
          wakeError: null,
        });
      }
    }
  }

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
            requiredWorkstreams: args.required_workstreams,
            provenance,
            sourceAssignmentId: exactSourceAssignmentId,
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
            sourceAssignmentId: exactSourceAssignmentId,
          },
        );

    await runtime.sessionStore.mutateThread(runContext.threadId, (current) => {
      if (current.channel !== runContext.channel) {
        throw new Error("session channel changed during pipeline start");
      }
      current.activePipelineRunId = started.run.id;
      current.activePipelineKind = started.run.kind;
      current.activeRunId = started.run.id;
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
      promoted: started.promoted === true,
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
  if (!runContext.signed || !runtime.sessionStore) {
    return textResult({ ok: false, reason: "signed pipeline session context required" }, true);
  }
  const session = await runtime.sessionStore.get(runContext.threadId);
  const caller = canonicalAgentName(runContext.agent) ?? runContext.agent;
  const invocation = caller === "default" || caller === "lead"
    ? session?.activePipelineInvocation
    : session?.agentSessions?.[caller]?.activePipelineInvocation;
  if (
    !session ||
    session.channel !== runContext.channel ||
    !invocation ||
    runContext.runId !== invocation.runId ||
    runContext.assignmentId !== invocation.assignmentId ||
    runContext.dispatchKey !== invocation.dispatchKey ||
    outcome.assignmentId !== invocation.assignmentId
  ) {
    return textResult(
      { ok: false, reason: "outcome does not match this signed active assignment" },
      true,
    );
  }
  const assignment = await runtime.store.getAssignment(outcome.assignmentId);
  const run = assignment ? await runtime.store.getRun(assignment.runId) : undefined;
  if (run && assignment) {
    const authFailure = authorizeAssignmentAction(run, assignment, runContext.agent);
    if (authFailure) return textResult({ ok: false, reason: authFailure }, true);
  }
  const delegatedBranch = assignment?.contextRefs.some((ref) =>
    ref.startsWith("delegated-branch:") || ref === "control-branch:human-input"
  ) === true;
  const receipt = !run || !assignment || run.kind === "default" || shadow || delegatedBranch
    ? await reportOutcome(
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
      )
    : run.kind === "product"
      ? await reduceProductOutcome(
          { store: runtime.store, workspaceRoot: runtime.workspaceRoot },
          {
            outcome,
            toPhase: args.to_phase,
            actorId: runContext.agent,
            idempotencyKey: args.idempotency_key,
          },
        )
      : await reduceBugOutcome(
          {
            store: runtime.store,
            jobStore: runtime.store,
            workspaceRoot: runtime.workspaceRoot,
          },
          {
            outcome,
            toPhase: args.to_phase,
            actorId: runContext.agent,
            idempotencyKey: args.idempotency_key,
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

/** Durable replacement for direct agent dispatch while an assignment is active. */
export async function pipelineDispatchAgent(
  runtime: PipelineToolRuntime,
  runContext: SlackMcpRunContext | null,
  args: {
    target_agent: string;
    objective: string;
    mode: "delegate" | "handoff";
    reason: string;
    idempotency_key: string;
    to_phase?: string;
    evidence_refs?: string[];
    artifact_refs?: string[];
    acceptance_criteria?: string[];
  },
): Promise<ToolTextResult> {
  const disabled = requireActive(runtime);
  if (disabled) return disabled;
  if (!runContext?.signed || !runtime.sessionStore) {
    return textResult({ ok: false, reason: "signed pipeline session context required" }, true);
  }
  if (args.mode === "delegate" && args.to_phase) {
    return textResult(
      { ok: false, reason: "delegate is phase-neutral; to_phase is only valid for handoff" },
      true,
    );
  }
  const session = await runtime.sessionStore.get(runContext.threadId);
  if (!session || session.channel !== runContext.channel) {
    return textResult({ ok: false, reason: "thread session not found" }, true);
  }
  const caller = canonicalAgentName(runContext.agent) ?? runContext.agent;
  const invocation = caller === "default" || caller === "lead"
    ? session.activePipelineInvocation
    : session.agentSessions?.[caller]?.activePipelineInvocation;
  if (!invocation) {
    return textResult({ ok: false, reason: "no active durable assignment for caller" }, true);
  }
  if (
    runContext.runId !== invocation.runId ||
    runContext.assignmentId !== invocation.assignmentId ||
    runContext.dispatchKey !== invocation.dispatchKey
  ) {
    return textResult({ ok: false, reason: "stale signed assignment context" }, true);
  }
  const [run, source] = await Promise.all([
    runtime.store.getRun(invocation.runId),
    runtime.store.getAssignment(invocation.assignmentId),
  ]);
  if (!run || !source || source.runId !== run.id || run.status === "terminal") {
    return textResult({ ok: false, reason: "active assignment state is missing or terminal" }, true);
  }
  const sourceAgent = canonicalAgentName(source.targetAgent) ?? source.targetAgent;
  if (sourceAgent !== caller) {
    return textResult({ ok: false, reason: "authenticated agent does not own the active assignment" }, true);
  }
  const target = canonicalAgentName(args.target_agent) ?? args.target_agent.trim();
  const dispatchContext = run.kind === "bug" ? "support" : "default";
  if (!canDispatch(source.targetAgent, target, dispatchContext)) {
    return textResult(
      { ok: false, reason: `unauthorized handoff edge: ${source.targetAgent} → ${target}` },
      true,
    );
  }
  const mutationScope = canEditProductCode(target)
    ? ["worktree-code"]
    : canWritePipelineArtifacts(target)
      ? ["pipeline-artifact"]
      : [];
  const stableKey = `${run.id}:${source.id}:${args.idempotency_key}`;
  const prior = (await runtime.store.listEvents(run.id)).find(
    (event) => event.idempotencyKey === stableKey,
  );
  if (prior) {
    const child = (await runtime.store.listAssignments(run.id)).find(
      (candidate) => candidate.idempotencyKey === `${stableKey}:next`,
    );
    return textResult({
      ok: true,
      mode: args.mode,
      runId: run.id,
      sourceAssignmentId: source.id,
      targetAssignmentId: child?.id,
      receipt: {
        status: "duplicate",
        runVersion: run.stateVersion,
        assignmentId: child?.id ?? source.id,
        eventId: prior.id,
        reason: "dispatch already committed",
      },
    });
  }
  const inheritedBranch = source.contextRefs.find((ref) =>
    ref.startsWith("delegated-branch:")
  );
  const delegatedBranch = inheritedBranch ??
    (args.mode === "delegate" ? `delegated-branch:${source.id}` : undefined);
  const contextRefs = [
    `dispatch-mode:${args.mode}`,
    ...(delegatedBranch ? [delegatedBranch] : []),
  ];
  const nextIdempotencyKey = `${stableKey}:next`;
  const dispatchOutcome: AgentOutcome = {
    assignmentId: source.id,
    expectedRunVersion: run.stateVersion,
    action: args.mode,
    status: "progress",
    targetAgent: target,
    reason: args.reason,
    evidenceRefs: args.evidence_refs ?? [],
    artifactRefs: args.artifact_refs ?? [],
    blockers: [],
    checks: [],
    progressFingerprint: `dispatch:${args.mode}:${target}:${args.idempotency_key}`,
    nextAssignment: {
      parentAssignmentId: source.id,
      targetAgent: target,
      objective: args.objective,
      contextRefs,
      artifactRefs: args.artifact_refs ?? [],
      acceptanceCriteria: args.acceptance_criteria ?? run.acceptanceCriteria,
      mutationScope,
      dependsOn: [],
      attempt: source.attempt,
      attemptId: source.attemptId,
      candidateRevisionDigest: source.candidateRevisionDigest,
      deadlineAt: source.deadlineAt ?? run.deadlineAt,
      idempotencyKey: nextIdempotencyKey,
    },
  };
  const genericDispatch =
    run.kind === "default" || args.mode === "delegate" || Boolean(inheritedBranch);
  const receipt = genericDispatch
    ? await requestHandoff(
        {
          store: runtime.store,
          githubTrackingEnabled: runtime.githubTrackingEnabled,
        },
        {
          assignmentId: source.id,
          expectedRunVersion: run.stateVersion,
          targetAgent: target,
          objective: args.objective,
          reason: args.reason,
          progressFingerprint: dispatchOutcome.progressFingerprint,
          evidenceRefs: dispatchOutcome.evidenceRefs,
          artifactRefs: dispatchOutcome.artifactRefs,
          acceptanceCriteria: args.acceptance_criteria ?? run.acceptanceCriteria,
          mutationScope,
          contextRefs,
          attempt: source.attempt,
          attemptId: source.attemptId,
          candidateRevisionDigest: source.candidateRevisionDigest,
          deadlineAt: source.deadlineAt ?? run.deadlineAt,
          idempotencyKey: stableKey,
          nextIdempotencyKey,
          action: args.mode,
          toPhase: args.to_phase,
          auth: authFromContext(runContext),
        },
      )
    : run.kind === "product"
      ? await reduceProductOutcome(
          { store: runtime.store, workspaceRoot: runtime.workspaceRoot },
          {
            outcome: dispatchOutcome,
            toPhase: args.to_phase,
            actorId: caller,
            idempotencyKey: stableKey,
          },
        )
      : await reduceBugOutcome(
          {
            store: runtime.store,
            jobStore: runtime.store,
            workspaceRoot: runtime.workspaceRoot,
          },
          {
            outcome: dispatchOutcome,
            toPhase: args.to_phase,
            actorId: caller,
            idempotencyKey: stableKey,
          },
        );
  if (receipt.status === "accepted" || receipt.status === "duplicate") {
    await runtime.onOutcomeCommitted?.(receipt);
  }
  return textResult(
    {
      ok: receipt.status !== "rejected",
      mode: args.mode,
      runId: run.id,
      sourceAssignmentId: source.id,
      targetAssignmentId: receipt.assignmentId,
      receipt,
    },
    receipt.status === "rejected",
  );
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
