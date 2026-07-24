/**
 * Shared pure decision helpers for recordOutcomeTransaction.
 * Stores apply the resulting writes atomically with CAS.
 */
import { validateOutcome } from "../policy.ts";
import { canTransition, isTerminalPhase } from "../transitions.ts";
import type {
  AgentOutcome,
  Assignment,
  AssignmentCreate,
  PipelineEvent,
  PipelineOutboxRecord,
  PipelinePhase,
  PipelineRun,
  PipelineRunStatus,
  StoredOutcome,
  TerminalOutcome,
  TransitionReceipt,
} from "../types.ts";

export type OutcomeTxDecision =
  | { kind: "receipt"; receipt: TransitionReceipt }
  | {
      kind: "commit";
      receipt: TransitionReceipt;
      updatedRun: PipelineRun;
      updatedAssignment: Assignment;
      outcome: StoredOutcome;
      event: PipelineEvent;
      nextAssignment: Assignment | null;
      resumedAssignment: Assignment | null;
      outbox: PipelineOutboxRecord | null;
    };

export type OutcomeTxContext = {
  run: PipelineRun;
  assignment: Assignment;
  /** Closest waiting ancestor that should resume when this branch completes. */
  waitingAncestor?: Assignment | null;
  recentFingerprints: string[];
  nextEventSequence: number;
  now: number;
  generateId: () => string;
  input: {
    outcome: AgentOutcome;
    toPhase?: string;
    repoRefs?: string[];
    actorType: "agent" | "human" | "system";
    actorId: string;
    idempotencyKey?: string;
  };
};

export function decideOutcomeTransaction(
  ctx: OutcomeTxContext,
): OutcomeTxDecision {
  const {
    run,
    assignment,
    waitingAncestor,
    input,
    now,
    generateId,
    nextEventSequence,
  } = ctx;
  const { outcome } = input;

  if (assignment.id !== outcome.assignmentId) {
    return receiptOnly({
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: outcome.assignmentId,
      reason: "assignment mismatch",
    });
  }

  // Terminal immutability — even before policy (cleanup bookkeeping only later).
  if (run.status === "terminal" || isTerminalPhase(run.kind, run.phase)) {
    return receiptOnly({
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: "terminal run is immutable",
    });
  }

  // Already completed assignment → duplicate if same fingerprint, else reject.
  if (assignment.status === "completed") {
    return receiptOnly({
      status: "duplicate",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: "assignment already completed",
    });
  }
  if (assignment.status === "waiting" && input.actorType === "agent") {
    return receiptOnly({
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: "assignment is waiting on delegated or external work",
    });
  }

  const policy = validateOutcome({
    run,
    assignment,
    outcome,
    recentFingerprints: ctx.recentFingerprints,
    now,
  });

  // Policy failures that demand escalation must still commit a durable
  // escalate → needs-human transition. Returning receipt-only leaves the run
  // active and spinning forever (not terminal, not needs-human).
  let effectiveOutcome = outcome;
  let forcedEscalate = false;
  if (!policy.ok) {
    if (policy.receiptStatus === "escalated") {
      forcedEscalate = true;
      effectiveOutcome = {
        ...outcome,
        action: "escalate",
        status: "blocked",
        targetAgent: undefined,
        nextAssignment: undefined,
        reason: policy.reason,
        blockers: [
          ...outcome.blockers,
          { kind: "no_progress", detail: policy.reason },
        ],
      };
    } else {
      return receiptOnly({
        status: policy.receiptStatus,
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason: policy.reason,
      });
    }
  }

  const resumesParent =
    outcome.action === "complete" && waitingAncestor?.status === "waiting";
  const defaultCompletionPhase =
    run.kind === "default" &&
      outcome.action === "complete" &&
      !resumesParent
      ? "completed"
      : run.phase;
  const toPhase = forcedEscalate
    ? "needs-human"
    : ((input.toPhase ?? defaultCompletionPhase) as string);
  if (
    !forcedEscalate &&
    toPhase !== run.phase &&
    !canTransition(run.kind, run.phase, toPhase)
  ) {
    return receiptOnly({
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: `illegal phase transition: ${run.phase} → ${toPhase}`,
    });
  }
  // Forced escalate may always move to needs-human when that edge is legal;
  // if not, still complete the assignment with escalate action on current phase.
  const resolvedToPhase =
    forcedEscalate && !canTransition(run.kind, run.phase, "needs-human")
      ? run.phase
      : toPhase;

  const outcomeId = generateId();
  const eventId = generateId();
  const newVersion = run.stateVersion + 1;

  const storedOutcome: StoredOutcome = {
    id: outcomeId,
    assignmentId: assignment.id,
    action: effectiveOutcome.action,
    status: effectiveOutcome.status,
    reason: effectiveOutcome.reason,
    evidenceRefs: [...effectiveOutcome.evidenceRefs],
    artifactRefs: [...effectiveOutcome.artifactRefs],
    blockers: effectiveOutcome.blockers.map((b) => ({ ...b })),
    checks: effectiveOutcome.checks.map((c) => ({ ...c })),
    confidence: effectiveOutcome.confidence ?? null,
    progressFingerprint: effectiveOutcome.progressFingerprint,
    createdAt: now,
  };

  const assignmentStatus =
    effectiveOutcome.action === "wait"
      ? ("waiting" as const)
      : effectiveOutcome.action === "delegate"
        ? ("waiting" as const)
      : effectiveOutcome.action === "continue_self"
        ? assignment.status === "pending"
          ? ("leased" as const)
          : assignment.status
        : ("completed" as const);

  const updatedAssignment: Assignment = {
    ...assignment,
    status: assignmentStatus,
    updatedAt: now,
    deadlineAt:
      effectiveOutcome.action === "wait" && effectiveOutcome.wait
        ? effectiveOutcome.wait.deadlineAt
        : assignment.deadlineAt,
  };

  const runStatus = deriveRunStatus(run, effectiveOutcome, resolvedToPhase);
  const terminalOutcome = deriveTerminalOutcome(
    effectiveOutcome,
    resolvedToPhase,
  );
  const updatedRun: PipelineRun = {
    ...run,
    phase: resolvedToPhase as PipelinePhase,
    status: runStatus,
    repoRefs: uniqueStrings([
      ...run.repoRefs,
      ...(input.repoRefs ?? []),
    ]),
    stateVersion: newVersion,
    terminalOutcome:
      runStatus === "terminal" ? terminalOutcome : run.terminalOutcome,
    terminalReason:
      runStatus === "terminal" ? effectiveOutcome.reason : run.terminalReason,
    artifactRefs: uniqueStrings([
      ...run.artifactRefs,
      ...effectiveOutcome.artifactRefs,
    ]),
    blockerRefs:
      effectiveOutcome.action === "escalate" ||
      effectiveOutcome.blockers.length > 0
        ? uniqueStrings([
            ...run.blockerRefs,
            ...effectiveOutcome.blockers.map((b) => `${b.kind}:${b.detail}`),
          ])
        : run.blockerRefs,
    deadlineAt:
      effectiveOutcome.action === "wait" && effectiveOutcome.wait
        ? effectiveOutcome.wait.deadlineAt
        : run.deadlineAt,
    updatedAt: now,
  } as PipelineRun;

  let nextAssignment: Assignment | null = null;
  let resumedAssignment: Assignment | null = null;
  let outbox: PipelineOutboxRecord | null = null;

  if (
    (effectiveOutcome.action === "handoff" ||
      effectiveOutcome.action === "delegate") &&
    effectiveOutcome.nextAssignment
  ) {
    const nextId = effectiveOutcome.nextAssignment.id ?? generateId();
    const create = effectiveOutcome.nextAssignment;
    nextAssignment = materializeNextAssignment(
      create,
      nextId,
      run.id,
      assignment.targetAgent,
      now,
    );
    outbox = {
      id: generateId(),
      runId: run.id,
      assignmentId: nextId,
      eventType: "assignment.dispatch",
      payload: {
        assignmentId: nextId,
        targetAgent: nextAssignment.targetAgent,
        parentAssignmentId: assignment.id,
      },
      status: "pending",
      attempts: 0,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey:
        input.idempotencyKey != null
          ? `dispatch:${input.idempotencyKey}`
          : `dispatch:${nextAssignment.idempotencyKey}`,
      createdAt: now,
      deliveredAt: null,
      lastError: null,
    };
  } else if (
    effectiveOutcome.action === "complete" &&
    waitingAncestor?.status === "waiting"
  ) {
    resumedAssignment = {
      ...waitingAncestor,
      status: "pending",
      updatedAt: now,
    };
    outbox = {
      id: generateId(),
      runId: run.id,
      assignmentId: waitingAncestor.id,
      eventType: "assignment.resume",
      payload: {
        assignmentId: waitingAncestor.id,
        completedChildAssignmentId: assignment.id,
      },
      status: "pending",
      attempts: 0,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey:
        input.idempotencyKey != null
          ? `resume-parent:${input.idempotencyKey}`
          : `resume-parent:${waitingAncestor.id}:${assignment.id}:${newVersion}`,
      createdAt: now,
      deliveredAt: null,
      lastError: null,
    };
  } else if (effectiveOutcome.action === "continue_self") {
    outbox = {
      id: generateId(),
      runId: run.id,
      assignmentId: assignment.id,
      eventType: "assignment.continue",
      payload: { assignmentId: assignment.id },
      status: "pending",
      attempts: 0,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey:
        input.idempotencyKey != null
          ? `continue:${input.idempotencyKey}`
          : `continue:${assignment.id}:${newVersion}`,
      createdAt: now,
      deliveredAt: null,
      lastError: null,
    };
  } else if (effectiveOutcome.action === "wait") {
    outbox = {
      id: generateId(),
      runId: run.id,
      assignmentId: assignment.id,
      eventType: "assignment.wait",
      payload: {
        assignmentId: assignment.id,
        conditionName: effectiveOutcome.wait?.conditionName,
        deadlineAt: effectiveOutcome.wait?.deadlineAt,
      },
      status: "pending",
      attempts: 0,
      availableAt: effectiveOutcome.wait?.deadlineAt ?? now,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey:
        input.idempotencyKey != null
          ? `wait:${input.idempotencyKey}`
          : `wait:${assignment.id}:${effectiveOutcome.wait?.conditionName ?? "unnamed"}`,
      createdAt: now,
      deliveredAt: null,
      lastError: null,
    };
  } else if (effectiveOutcome.action === "escalate") {
    outbox = {
      id: generateId(),
      runId: run.id,
      assignmentId: assignment.id,
      eventType: "assignment.escalate",
      payload: {
        assignmentId: assignment.id,
        reason: effectiveOutcome.reason,
        blockers: effectiveOutcome.blockers,
      },
      status: "pending",
      attempts: 0,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey:
        input.idempotencyKey != null
          ? `escalate:${input.idempotencyKey}`
          : `escalate:${assignment.id}:${newVersion}`,
      createdAt: now,
      deliveredAt: null,
      lastError: null,
    };
  }

  const event: PipelineEvent = {
    id: eventId,
    runId: run.id,
    sequence: nextEventSequence,
    eventType: `outcome.${effectiveOutcome.action}`,
    actorType: input.actorType,
    actorId: input.actorId,
    assignmentId: assignment.id,
    outcomeId,
    fromPhase: run.phase,
    toPhase: resolvedToPhase,
    payloadVersion: 1,
    payload: {
      action: effectiveOutcome.action,
      status: effectiveOutcome.status,
      reason: effectiveOutcome.reason,
      progressFingerprint: effectiveOutcome.progressFingerprint,
      wait: effectiveOutcome.wait ?? null,
      targetAgent: effectiveOutcome.targetAgent ?? null,
      // Include revision digest so loop policy can distinguish rework on a
      // new candidate from a pure no-progress spin.
      candidateRevisionDigest:
        effectiveOutcome.nextAssignment?.candidateRevisionDigest ??
        assignment.candidateRevisionDigest ??
        null,
    },
    idempotencyKey: input.idempotencyKey ?? null,
    occurredAt: now,
    observedAt: now,
  };

  const receiptStatus = forcedEscalate
    ? ("escalated" as const)
    : policy.ok
      ? policy.receiptStatus
      : ("escalated" as const);
  return {
    kind: "commit",
    receipt: {
      status: receiptStatus,
      runVersion: newVersion,
      assignmentId:
        nextAssignment?.id ?? assignment.id,
      reason: outcome.reason,
      outcomeId,
      eventId,
    },
    updatedRun,
    updatedAssignment,
    outcome: storedOutcome,
    event,
    nextAssignment,
    resumedAssignment,
    outbox,
  };
}

function receiptOnly(receipt: TransitionReceipt): OutcomeTxDecision {
  return { kind: "receipt", receipt };
}

function materializeNextAssignment(
  create: NonNullable<AgentOutcome["nextAssignment"]>,
  id: string,
  runId: string,
  sourceAgent: string,
  now: number,
): Assignment {
  const base: AssignmentCreate = {
    id,
    runId,
    parentAssignmentId: create.parentAssignmentId,
    sourceAgent,
    sourceSlackUserId: create.sourceSlackUserId ?? null,
    targetAgent: create.targetAgent,
    objective: create.objective,
    contextRefs: create.contextRefs ?? [],
    artifactRefs: create.artifactRefs ?? [],
    acceptanceCriteria: create.acceptanceCriteria ?? [],
    mutationScope: create.mutationScope ?? [],
    dependsOn: create.dependsOn ?? [],
    attempt: create.attempt,
    attemptId: create.attemptId ?? null,
    candidateRevisionDigest: create.candidateRevisionDigest ?? null,
    deadlineAt: create.deadlineAt ?? null,
    idempotencyKey: create.idempotencyKey,
    status: "pending",
  };
  return {
    ...base,
    status: "pending",
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function deriveRunStatus(
  run: PipelineRun,
  outcome: AgentOutcome,
  toPhase: string,
): PipelineRunStatus {
  if (isTerminalPhase(run.kind, toPhase)) return "terminal";
  if (outcome.action === "escalate" || toPhase === "needs-human") {
    return "needs-human";
  }
  if (outcome.action === "wait") return "waiting";
  return "active";
}

function deriveTerminalOutcome(
  outcome: AgentOutcome,
  toPhase: string,
): TerminalOutcome {
  if (toPhase === "shipped") return "shipped";
  if (toPhase === "completed") return "completed";
  if (toPhase === "merged" || toPhase === "cleanup") return "merged";
  if (toPhase === "expected-behavior" || outcome.status === "expected_behavior") {
    return "expected-behavior";
  }
  if (toPhase === "not-reproduced" || outcome.status === "not_reproduced") {
    return "not-reproduced";
  }
  if (toPhase === "abandoned") return "abandoned";
  return null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
