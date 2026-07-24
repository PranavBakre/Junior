/**
 * Authenticated structured outcomes and handoffs.
 *
 * Agents propose transitions; this module validates authority, PR registration
 * gates, and loop policy, then commits via store.recordOutcomeTransaction.
 * Dispatch is scheduled through the outbox (pump), not inline, so a crash
 * between commit and wake is recoverable.
 */

import { canDispatch } from "../support/agents.ts";
import {
  canonicalAgentName,
  resolveHandoffTarget,
  type OrchestratorContext,
} from "../agents/registry.ts";
import { log } from "../logger.ts";
import type { PipelineStore } from "./store/interface.ts";
import type {
  AgentOutcome,
  Assignment,
  GitHubResourceRegistration,
  PipelineRun,
  TransitionReceipt,
} from "./types.ts";

export type OutcomeAuthContext = {
  /** Authenticated MCP / runtime agent name. */
  agent: string;
  channelId: string;
  threadId: string;
  orchestratorContext?: OrchestratorContext;
  /**
   * When true, agent "system" / "human" may act without owning the assignment.
   * Must only be set by trusted internal callers (legacy directive conversion,
   * pump, controllers) — never from raw MCP URL query params.
   */
  trustedInternal?: boolean;
};

export type ReportOutcomeInput = {
  outcome: AgentOutcome;
  /** Proposed phase advance. Omitted means keep current phase. */
  toPhase?: string;
  /** Repository refs atomically bound when the transition commits. */
  repoRefs?: string[];
  /** Optional event idempotency key for duplicate detection. */
  idempotencyKey?: string;
  auth: OutcomeAuthContext;
};

export type OutcomesDeps = {
  store: PipelineStore;
  /** When true, completing a PR-opening phase requires registered PRs. */
  githubTrackingEnabled?: boolean;
  now?: () => number;
  /**
   * Shadow mode: persist outcomes without enqueueing dispatch outbox items.
   */
  suppressDispatch?: boolean;
};

/**
 * Loop-policy key: (run, source, target, progressFingerprint, candidateRevisionDigest).
 * Unchanged fingerprint without new evidence escalates; a new revision digests permits rework.
 */
export function loopPolicyKey(args: {
  runId: string;
  sourceAgent: string;
  targetAgent: string;
  progressFingerprint: string;
  candidateRevisionDigest: string | null;
}): string {
  return [
    args.runId,
    args.sourceAgent,
    args.targetAgent,
    args.progressFingerprint,
    args.candidateRevisionDigest ?? "",
  ].join("|");
}

/**
 * Parse and lightly validate an AgentOutcome-shaped object from tool input.
 * Throws with a human-readable message on structural failure.
 */
export function parseAgentOutcome(raw: unknown): AgentOutcome {
  if (!raw || typeof raw !== "object") {
    throw new Error("outcome must be an object");
  }
  const o = raw as Record<string, unknown>;
  const assignmentId = requiredString(o.assignmentId, "assignmentId");
  const expectedRunVersion = requiredNumber(
    o.expectedRunVersion,
    "expectedRunVersion",
  );
  const action = o.action;
  if (
    action !== "continue_self" &&
    action !== "delegate" &&
    action !== "handoff" &&
    action !== "wait" &&
    action !== "escalate" &&
    action !== "complete"
  ) {
    throw new Error(
      `invalid action: ${String(action)} (expected continue_self|delegate|handoff|wait|escalate|complete)`,
    );
  }
  const status = o.status;
  if (
    status !== "progress" &&
    status !== "succeeded" &&
    status !== "expected_behavior" &&
    status !== "not_reproduced" &&
    status !== "blocked" &&
    status !== "failed"
  ) {
    throw new Error(`invalid status: ${String(status)}`);
  }
  const reason = requiredString(o.reason, "reason");
  const progressFingerprint = requiredString(
    o.progressFingerprint,
    "progressFingerprint",
  );

  const outcome: AgentOutcome = {
    assignmentId,
    expectedRunVersion,
    action,
    status,
    reason,
    evidenceRefs: stringArray(o.evidenceRefs, "evidenceRefs"),
    artifactRefs: stringArray(o.artifactRefs, "artifactRefs"),
    blockers: parseBlockers(o.blockers),
    checks: parseChecks(o.checks),
    progressFingerprint,
  };

  if (typeof o.targetAgent === "string" && o.targetAgent.trim()) {
    outcome.targetAgent = o.targetAgent.trim();
  }
  if (typeof o.confidence === "number" && Number.isFinite(o.confidence)) {
    outcome.confidence = o.confidence;
  }
  if (o.wait && typeof o.wait === "object") {
    const w = o.wait as Record<string, unknown>;
    outcome.wait = {
      conditionName: requiredString(w.conditionName, "wait.conditionName"),
      deadlineAt: requiredNumber(w.deadlineAt, "wait.deadlineAt"),
    };
  }
  if (o.nextAssignment && typeof o.nextAssignment === "object") {
    const n = o.nextAssignment as Record<string, unknown>;
    outcome.nextAssignment = {
      parentAssignmentId:
        n.parentAssignmentId == null
          ? null
          : requiredString(n.parentAssignmentId, "nextAssignment.parentAssignmentId"),
      sourceSlackUserId: null,
      targetAgent: requiredString(n.targetAgent, "nextAssignment.targetAgent"),
      objective: requiredString(n.objective, "nextAssignment.objective"),
      contextRefs: stringArray(n.contextRefs ?? [], "nextAssignment.contextRefs"),
      artifactRefs: stringArray(
        n.artifactRefs ?? [],
        "nextAssignment.artifactRefs",
      ),
      acceptanceCriteria: stringArray(
        n.acceptanceCriteria ?? [],
        "nextAssignment.acceptanceCriteria",
      ),
      mutationScope: stringArray(
        n.mutationScope ?? [],
        "nextAssignment.mutationScope",
      ),
      dependsOn: stringArray(n.dependsOn ?? [], "nextAssignment.dependsOn"),
      attempt: requiredNumber(n.attempt ?? 1, "nextAssignment.attempt"),
      attemptId:
        n.attemptId == null
          ? null
          : requiredString(n.attemptId, "nextAssignment.attemptId"),
      candidateRevisionDigest:
        n.candidateRevisionDigest == null
          ? null
          : requiredString(
              n.candidateRevisionDigest,
              "nextAssignment.candidateRevisionDigest",
            ),
      deadlineAt:
        n.deadlineAt == null
          ? null
          : requiredNumber(n.deadlineAt, "nextAssignment.deadlineAt"),
      idempotencyKey: requiredString(
        n.idempotencyKey,
        "nextAssignment.idempotencyKey",
      ),
      ...(typeof n.id === "string" ? { id: n.id } : {}),
    };
  }

  return outcome;
}

/**
 * Authenticate the caller against the assignment, validate handoff authority
 * and PR registration gates, then commit the outcome transaction.
 */
export async function reportOutcome(
  deps: OutcomesDeps,
  input: ReportOutcomeInput,
): Promise<TransitionReceipt> {
  const { outcome, auth } = input;
  const assignment = await deps.store.getAssignment(outcome.assignmentId);
  if (!assignment) {
    const receipt: TransitionReceipt = {
      status: "rejected",
      runVersion: 0,
      assignmentId: outcome.assignmentId,
      reason: "assignment not found",
    };
    logRejectedOutcome(null, outcome.assignmentId, "assignment not found");
    return receipt;
  }

  const run = await deps.store.getRun(assignment.runId);
  if (!run) {
    const receipt: TransitionReceipt = {
      status: "rejected",
      runVersion: 0,
      assignmentId: assignment.id,
      reason: "run not found",
    };
    logRejectedOutcome(assignment.runId, assignment.id, "run not found");
    return receipt;
  }

  const authFailure = authenticateAssignment(run, assignment, auth);
  if (authFailure) {
    const receipt: TransitionReceipt = {
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: authFailure,
    };
    logRejectedOutcome(run.id, assignment.id, authFailure);
    return receipt;
  }

  // Handoff edge authority (catalog graph).
  if (outcome.action === "handoff" || outcome.action === "delegate") {
    const target =
      outcome.targetAgent ?? outcome.nextAssignment?.targetAgent ?? "";
    const source = assignment.targetAgent;
    const ctx = auth.orchestratorContext ?? orchestratorContextFor(run);
    if (!canDispatch(source, target, ctx)) {
      const reason = `unauthorized handoff edge: ${source} → ${target}`;
      logRejectedOutcome(run.id, assignment.id, reason);
      return {
        status: "rejected",
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason,
      };
    }

    // Loop policy: same (run, source, target, fingerprint, revision) without
    // new evidence escalates rather than spinning.
    const loopKey = loopPolicyKey({
      runId: run.id,
      sourceAgent: source,
      targetAgent: resolveHandoffTarget(target, ctx),
      progressFingerprint: outcome.progressFingerprint,
      candidateRevisionDigest:
        outcome.nextAssignment?.candidateRevisionDigest ??
        assignment.candidateRevisionDigest,
    });
    const prior = await findPriorLoopFingerprint(deps.store, run.id, loopKey);
    if (prior && outcome.evidenceRefs.length === 0) {
      // Persist a synthetic escalation so the assignment/run cannot spin forever.
      const reason =
        "loop policy: unchanged (run, source, target, progressFingerprint, candidateRevisionDigest) without new evidence";
      log.info(
        "pipeline-outcomes",
        `escalated loop-policy run=${run.id} assignment=${assignment.id}: ${reason}`,
      );
      const escalated: AgentOutcome = {
        ...outcome,
        action: "escalate",
        status: "blocked",
        targetAgent: undefined,
        nextAssignment: undefined,
        reason,
        blockers: [
          ...(outcome.blockers ?? []),
          { kind: "no_progress", detail: reason },
        ],
        progressFingerprint: outcome.progressFingerprint || loopKey,
      };
      return reportOutcome(deps, {
        outcome: escalated,
        toPhase: "needs-human",
        repoRefs: input.repoRefs,
        idempotencyKey:
          input.idempotencyKey ??
          `loop-escalate:${loopKey}:${assignment.id}`,
        auth,
      });
    }
  }

  // PR-opening completion requires exact resource registration when tracking is on.
  if (
    deps.githubTrackingEnabled &&
    isPrOpenCompletion(run, outcome, input.toPhase)
  ) {
    const assocs = await deps.store.listPipelineGitHubResources(run.id, true);
    const registered = assocs.filter(
      (a) =>
        a.role === "candidate" ||
        a.role === "dev-pr" ||
        a.role === "main-pr" ||
        a.role === "review-target",
    );
    if (registered.length === 0) {
      const reason =
        "PR-opening completion requires registered PRs (pipeline_register_pr) when GitHub tracking is enabled";
      logRejectedOutcome(run.id, assignment.id, reason);
      return {
        status: "rejected",
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason,
      };
    }
    const missingSha = registered.find((a) => !a.expectedHeadSha?.trim());
    if (missingSha) {
      const reason = `registered PR association ${missingSha.id} is missing expectedHeadSha`;
      logRejectedOutcome(run.id, assignment.id, reason);
      return {
        status: "rejected",
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason,
      };
    }
  }

  const receipt = await deps.store.recordOutcomeTransaction({
    outcome,
    toPhase: input.toPhase,
    repoRefs: input.repoRefs,
    actorType: "agent",
    actorId: auth.agent,
    idempotencyKey: input.idempotencyKey,
    suppressDispatch: deps.suppressDispatch === true,
  });

  if (
    receipt.status === "accepted" ||
    receipt.status === "waiting" ||
    receipt.status === "escalated"
  ) {
    log.info(
      "pipeline-outcomes",
      `outcome ${outcome.action} ${receipt.status} run=${run.id} assignment=${assignment.id} v${receipt.runVersion}`,
    );
  } else if (receipt.status === "rejected") {
    logRejectedOutcome(run.id, assignment.id, receipt.reason ?? "rejected");
  }

  return receipt;
}

function logRejectedOutcome(
  runId: string | null,
  assignmentId: string,
  reason: string,
): void {
  log.info(
    "pipeline-outcomes",
    `rejected transition run=${runId ?? "unknown"} assignment=${assignmentId}: ${reason}`,
  );
}

/**
 * Convenience: build a handoff outcome from structured fields and report it.
 */
export async function requestHandoff(
  deps: OutcomesDeps,
  args: {
    assignmentId: string;
    expectedRunVersion: number;
    targetAgent: string;
    objective: string;
    reason: string;
    progressFingerprint: string;
    evidenceRefs?: string[];
    artifactRefs?: string[];
    acceptanceCriteria?: string[];
    repoRefs?: string[];
    mutationScope?: string[];
    contextRefs?: string[];
    dependsOn?: string[];
    attempt?: number;
    attemptId?: string | null;
    candidateRevisionDigest?: string | null;
    deadlineAt?: number | null;
    idempotencyKey: string;
    nextIdempotencyKey: string;
    action?: "handoff" | "delegate";
    toPhase?: string;
    auth: OutcomeAuthContext;
  },
): Promise<TransitionReceipt> {
  const outcome: AgentOutcome = {
    assignmentId: args.assignmentId,
    expectedRunVersion: args.expectedRunVersion,
    action: args.action ?? "handoff",
    status: "progress",
    targetAgent: args.targetAgent,
    reason: args.reason,
    evidenceRefs: args.evidenceRefs ?? [],
    artifactRefs: args.artifactRefs ?? [],
    blockers: [],
    checks: [],
    progressFingerprint: args.progressFingerprint,
    nextAssignment: {
      parentAssignmentId: args.assignmentId,
      sourceSlackUserId: null,
      targetAgent: args.targetAgent,
      objective: args.objective,
      contextRefs: args.contextRefs ?? [],
      artifactRefs: args.artifactRefs ?? [],
      acceptanceCriteria: args.acceptanceCriteria ?? [],
      mutationScope: args.mutationScope ?? [],
      dependsOn: args.dependsOn ?? [],
      attempt: args.attempt ?? 1,
      attemptId: args.attemptId ?? null,
      candidateRevisionDigest: args.candidateRevisionDigest ?? null,
      deadlineAt: args.deadlineAt ?? null,
      idempotencyKey: args.nextIdempotencyKey,
    },
  };

  return reportOutcome(deps, {
    outcome,
    toPhase: args.toPhase,
    repoRefs: args.repoRefs,
    idempotencyKey: args.idempotencyKey,
    auth: args.auth,
  });
}

/**
 * Record a durable PR registration event (and optional association row).
 * Phase 5 materializes full github_resources; here we append an event and
 * register the pipeline association when a resource id is already known.
 */
export async function registerPr(
  deps: OutcomesDeps,
  registration: GitHubResourceRegistration,
  auth: OutcomeAuthContext,
): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }> {
  const run = await deps.store.getRun(registration.runId);
  if (!run) return { ok: false, reason: "run not found" };

  if (run.channelId !== auth.channelId || run.threadId !== auth.threadId) {
    return { ok: false, reason: "run does not match authenticated thread/channel" };
  }

  const assignment = await deps.store.getAssignment(registration.assignmentId);
  if (!assignment || assignment.runId !== run.id) {
    return { ok: false, reason: "assignment not found for run" };
  }

  const authFailure = authenticateAssignment(run, assignment, auth);
  if (authFailure) return { ok: false, reason: authFailure };

  const now = deps.now?.() ?? Date.now();
  // Single atomic store method: event + resource + association.
  const result = await deps.store.commitPrRegistration({
    registration,
    actorId: auth.agent,
    runPhase: run.phase,
    now,
  });
  return { ok: true, eventId: result.eventId };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function authenticateAssignment(
  run: PipelineRun,
  assignment: Assignment,
  auth: OutcomeAuthContext,
): string | null {
  if (run.channelId !== auth.channelId || run.threadId !== auth.threadId) {
    return "assignment run does not match authenticated thread/channel";
  }

  const caller =
    canonicalAgentName(auth.agent) ?? auth.agent.trim();
  const target =
    canonicalAgentName(assignment.targetAgent) ?? assignment.targetAgent;

  // Assignment owner (target) may report.
  if (caller === target) return null;

  // Internal system/human actors only when explicitly marked trusted (never from
  // spoofable MCP URL params — set by SessionManager / pipeline pump only).
  if (
    auth.trustedInternal === true &&
    (caller === "system" || caller === "human")
  ) {
    return null;
  }

  // Orchestrators that own the run may report on behalf of any assignment.
  const isOrch =
    caller === "lead" ||
    caller === "default" ||
    caller === "junior" ||
    caller === run.ownerAgent ||
    canonicalAgentName(run.ownerAgent) === caller;
  if (isOrch) return null;

  return `agent "${auth.agent}" is not authorized to report for assignment target "${assignment.targetAgent}"`;
}

function isPrOpenCompletion(
  run: PipelineRun,
  outcome: AgentOutcome,
  toPhase?: string,
): boolean {
  if (run.phase !== "pr-open") return false;
  if (outcome.action === "complete") return true;
  if (toPhase && toPhase !== "pr-open" && toPhase !== "needs-human" && toPhase !== "abandoned") {
    return true;
  }
  // handoff out of pr-open (e.g. to review) counts as completing PR-open work
  if (outcome.action === "handoff" && outcome.targetAgent === "review") {
    return true;
  }
  return false;
}

async function findPriorLoopFingerprint(
  store: PipelineStore,
  runId: string,
  loopKey: string,
): Promise<boolean> {
  const events = await store.listEvents(runId);
  for (const event of events) {
    if (!event.eventType.startsWith("outcome.")) continue;
    const payload = event.payload;
    const fp = typeof payload.progressFingerprint === "string"
      ? payload.progressFingerprint
      : null;
    const target =
      typeof payload.targetAgent === "string" ? payload.targetAgent : "";
    const source = event.actorId;
    const digest =
      typeof payload.candidateRevisionDigest === "string"
        ? payload.candidateRevisionDigest
        : payload.candidateRevisionDigest === null
          ? null
          : undefined;
    if (!fp) continue;
    // When either side carries a digest, require exact digest equality so a
    // new revision rework is not treated as a no-progress loop.
    const prior = loopPolicyKey({
      runId,
      sourceAgent: source,
      targetAgent: target,
      progressFingerprint: fp,
      candidateRevisionDigest: digest === undefined ? null : digest,
    });
    if (prior === loopKey) return true;
    // Compare fingerprint + target + digest (source may be actor not assignment target)
    const priorSuffix = `|${target}|${fp}|${digest === undefined ? "" : (digest ?? "")}`;
    if (loopKey.endsWith(priorSuffix) && prior.endsWith(priorSuffix)) {
      return true;
    }
  }
  return false;
}

function orchestratorContextFor(run: PipelineRun): OrchestratorContext {
  return run.kind === "bug" ? "support" : "default";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((v, i) => {
    if (typeof v !== "string") {
      throw new Error(`${field}[${i}] must be a string`);
    }
    return v;
  });
}

function parseBlockers(
  value: unknown,
): AgentOutcome["blockers"] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("blockers must be an array");
  }
  return value.map((b, i) => {
    if (!b || typeof b !== "object") {
      throw new Error(`blockers[${i}] must be an object`);
    }
    const row = b as Record<string, unknown>;
    const kind = row.kind;
    const allowed = [
      "missing_context",
      "missing_authority",
      "human_gate",
      "unsafe_mutation",
      "conflicting_evidence",
      "no_progress",
      "infra_failure",
    ] as const;
    if (typeof kind !== "string" || !(allowed as readonly string[]).includes(kind)) {
      throw new Error(`blockers[${i}].kind is invalid`);
    }
    return {
      kind: kind as AgentOutcome["blockers"][number]["kind"],
      detail: requiredString(row.detail, `blockers[${i}].detail`),
    };
  });
}

function parseChecks(value: unknown): AgentOutcome["checks"] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("checks must be an array");
  }
  return value.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new Error(`checks[${i}] must be an object`);
    }
    const row = c as Record<string, unknown>;
    const status = row.status;
    if (status !== "passed" && status !== "failed" && status !== "skipped") {
      throw new Error(`checks[${i}].status is invalid`);
    }
    return {
      name: requiredString(row.name, `checks[${i}].name`),
      status,
      ...(typeof row.evidenceRef === "string"
        ? { evidenceRef: row.evidenceRef }
        : {}),
    };
  });
}
