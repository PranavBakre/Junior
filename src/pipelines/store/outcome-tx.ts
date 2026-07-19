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
      outbox: PipelineOutboxRecord | null;
    };

export type OutcomeTxContext = {
  run: PipelineRun;
  assignment: Assignment;
  recentFingerprints: string[];
  nextEventSequence: number;
  now: number;
  generateId: () => string;
  input: {
    outcome: AgentOutcome;
    toPhase?: string;
    actorType: "agent" | "human" | "system";
    actorId: string;
    idempotencyKey?: string;
  };
};

export function decideOutcomeTransaction(
  ctx: OutcomeTxContext,
): OutcomeTxDecision {
  const { run, assignment, input, now, generateId, nextEventSequence } = ctx;
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

  const policy = validateOutcome({
    run,
    assignment,
    outcome,
    recentFingerprints: ctx.recentFingerprints,
    now,
  });

  if (!policy.ok) {
    return receiptOnly({
      status: policy.receiptStatus,
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: policy.reason,
    });
  }

  const toPhase = (input.toPhase ?? run.phase) as string;
  if (toPhase !== run.phase && !canTransition(run.kind, run.phase, toPhase)) {
    return receiptOnly({
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: `illegal phase transition: ${run.phase} → ${toPhase}`,
    });
  }

  const outcomeId = generateId();
  const eventId = generateId();
  const newVersion = run.stateVersion + 1;

  const storedOutcome: StoredOutcome = {
    id: outcomeId,
    assignmentId: assignment.id,
    action: outcome.action,
    status: outcome.status,
    reason: outcome.reason,
    evidenceRefs: [...outcome.evidenceRefs],
    artifactRefs: [...outcome.artifactRefs],
    blockers: outcome.blockers.map((b) => ({ ...b })),
    checks: outcome.checks.map((c) => ({ ...c })),
    confidence: outcome.confidence ?? null,
    progressFingerprint: outcome.progressFingerprint,
    createdAt: now,
  };

  const assignmentStatus =
    outcome.action === "wait"
      ? ("waiting" as const)
      : outcome.action === "continue_self"
        ? assignment.status === "pending"
          ? ("leased" as const)
          : assignment.status
        : ("completed" as const);

  const updatedAssignment: Assignment = {
    ...assignment,
    status: assignmentStatus,
    updatedAt: now,
    deadlineAt:
      outcome.action === "wait" && outcome.wait
        ? outcome.wait.deadlineAt
        : assignment.deadlineAt,
  };

  const runStatus = deriveRunStatus(run, outcome, toPhase);
  const terminalOutcome = deriveTerminalOutcome(outcome, toPhase);
  const updatedRun: PipelineRun = {
    ...run,
    phase: toPhase as PipelinePhase,
    status: runStatus,
    stateVersion: newVersion,
    terminalOutcome:
      runStatus === "terminal" ? terminalOutcome : run.terminalOutcome,
    terminalReason:
      runStatus === "terminal" ? outcome.reason : run.terminalReason,
    artifactRefs: uniqueStrings([
      ...run.artifactRefs,
      ...outcome.artifactRefs,
    ]),
    blockerRefs:
      outcome.action === "escalate" || outcome.blockers.length > 0
        ? uniqueStrings([
            ...run.blockerRefs,
            ...outcome.blockers.map((b) => `${b.kind}:${b.detail}`),
          ])
        : run.blockerRefs,
    deadlineAt:
      outcome.action === "wait" && outcome.wait
        ? outcome.wait.deadlineAt
        : run.deadlineAt,
    updatedAt: now,
  } as PipelineRun;

  let nextAssignment: Assignment | null = null;
  let outbox: PipelineOutboxRecord | null = null;

  if (outcome.action === "handoff" && outcome.nextAssignment) {
    const nextId = outcome.nextAssignment.id ?? generateId();
    const create = outcome.nextAssignment;
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
  } else if (outcome.action === "continue_self") {
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
  } else if (outcome.action === "wait") {
    outbox = {
      id: generateId(),
      runId: run.id,
      assignmentId: assignment.id,
      eventType: "assignment.wait",
      payload: {
        assignmentId: assignment.id,
        conditionName: outcome.wait?.conditionName,
        deadlineAt: outcome.wait?.deadlineAt,
      },
      status: "pending",
      attempts: 0,
      availableAt: outcome.wait?.deadlineAt ?? now,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey:
        input.idempotencyKey != null
          ? `wait:${input.idempotencyKey}`
          : `wait:${assignment.id}:${outcome.wait?.conditionName ?? "unnamed"}`,
      createdAt: now,
      deliveredAt: null,
      lastError: null,
    };
  } else if (outcome.action === "escalate") {
    outbox = {
      id: generateId(),
      runId: run.id,
      assignmentId: assignment.id,
      eventType: "assignment.escalate",
      payload: {
        assignmentId: assignment.id,
        reason: outcome.reason,
        blockers: outcome.blockers,
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
    eventType: `outcome.${outcome.action}`,
    actorType: input.actorType,
    actorId: input.actorId,
    assignmentId: assignment.id,
    outcomeId,
    fromPhase: run.phase,
    toPhase,
    payloadVersion: 1,
    payload: {
      action: outcome.action,
      status: outcome.status,
      reason: outcome.reason,
      progressFingerprint: outcome.progressFingerprint,
      wait: outcome.wait ?? null,
      targetAgent: outcome.targetAgent ?? null,
    },
    idempotencyKey: input.idempotencyKey ?? null,
    occurredAt: now,
    observedAt: now,
  };

  const receiptStatus = policy.receiptStatus;
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
