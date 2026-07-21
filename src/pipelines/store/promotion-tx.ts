import type {
  Assignment,
  DefaultRun,
  DefaultRunPromotionInput,
  PipelineEvent,
  PipelineOutboxRecord,
  PipelineRun,
  StoredOutcome,
  TransitionReceipt,
} from "../types.ts";
import { isBugPhase, isProductPhase } from "../transitions.ts";

export type DefaultPromotionDecision =
  | { kind: "receipt"; receipt: TransitionReceipt }
  | {
      kind: "commit";
      receipt: TransitionReceipt;
      updatedRun: PipelineRun;
      updatedSource: Assignment;
      childAssignments: Assignment[];
      sourceOutcome: StoredOutcome;
      events: PipelineEvent[];
      outbox: PipelineOutboxRecord[];
    };

export function decideDefaultPromotion(input: {
  run: DefaultRun;
  sourceAssignment: Assignment;
  request: DefaultRunPromotionInput;
  nextEventSequence: number;
  now: number;
  generateId: () => string;
}): DefaultPromotionDecision {
  const { run, sourceAssignment, request, now, generateId } = input;
  if (run.status === "terminal") {
    return rejected(run, sourceAssignment.id, "terminal default run cannot be promoted");
  }
  if (sourceAssignment.runId !== run.id || sourceAssignment.id !== request.sourceAssignmentId) {
    return rejected(run, request.sourceAssignmentId, "source assignment does not belong to run");
  }
  if (sourceAssignment.status !== "pending" && sourceAssignment.status !== "leased") {
    return rejected(run, sourceAssignment.id, `source assignment is ${sourceAssignment.status}`);
  }
  if (request.expectedRunVersion !== run.stateVersion) {
    return rejected(
      run,
      sourceAssignment.id,
      `state version conflict: expected ${request.expectedRunVersion}, actual ${run.stateVersion}`,
    );
  }
  if (request.targetRun.id !== run.id || request.targetRun.threadId !== run.threadId) {
    return rejected(run, sourceAssignment.id, "promotion target must preserve run and thread identity");
  }
  if (request.targetRun.channelId !== run.channelId) {
    return rejected(run, sourceAssignment.id, "promotion target must preserve channel identity");
  }
  if (
    request.targetRun.status !== "active" ||
    request.targetRun.terminalOutcome !== null ||
    request.targetRun.terminalReason !== null ||
    (request.targetRun.kind === "product" && !isProductPhase(request.targetRun.phase)) ||
    (request.targetRun.kind === "bug" && !isBugPhase(request.targetRun.phase))
  ) {
    return rejected(run, sourceAssignment.id, "promotion target must be a valid active typed run");
  }
  if (request.childAssignment.runId !== run.id) {
    return rejected(run, sourceAssignment.id, "child assignment must belong to promoted run");
  }
  if (request.childAssignment.parentAssignmentId !== sourceAssignment.id) {
    return rejected(run, sourceAssignment.id, "child assignment must descend from source assignment");
  }
  for (const additional of request.additionalAssignments ?? []) {
    if (
      additional.runId !== run.id ||
      additional.parentAssignmentId !== sourceAssignment.id
    ) {
      return rejected(
        run,
        sourceAssignment.id,
        "every promoted assignment must belong to the run and descend from the source",
      );
    }
  }

  const newVersion = run.stateVersion + 1;
  const outcomeId = generateId();
  const outcomeEventId = generateId();
  const promotionEventId = generateId();
  const childAssignments = [
    request.childAssignment,
    ...(request.additionalAssignments ?? []),
  ].map((assignment) => ({
    ...assignment,
    status: assignment.status ?? "pending",
    leaseOwner: assignment.leaseOwner ?? null,
    leaseExpiresAt: assignment.leaseExpiresAt ?? null,
    createdAt: now,
    updatedAt: now,
  } satisfies Assignment));
  const child = childAssignments[0]!;
  const updatedRun: PipelineRun = {
    ...request.targetRun,
    id: run.id,
    channelId: run.channelId,
    threadId: run.threadId,
    createdAt: run.createdAt,
    stateVersion: newVersion,
    repoRefs: unique([...run.repoRefs, ...request.targetRun.repoRefs]),
    acceptanceCriteria: unique([
      ...run.acceptanceCriteria,
      ...request.targetRun.acceptanceCriteria,
    ]),
    artifactRefs: unique([...run.artifactRefs, ...request.targetRun.artifactRefs]),
    blockerRefs: unique([...run.blockerRefs, ...request.targetRun.blockerRefs]),
    updatedAt: now,
  } as PipelineRun;
  const updatedSource: Assignment = {
    ...sourceAssignment,
    status: "completed",
    updatedAt: now,
  };
  const sourceOutcome: StoredOutcome = {
    id: outcomeId,
    assignmentId: sourceAssignment.id,
    action: "handoff",
    status: "progress",
    reason: request.reason,
    evidenceRefs: [],
    artifactRefs: [],
    blockers: [],
    checks: [],
    confidence: null,
    progressFingerprint: request.progressFingerprint,
    createdAt: now,
  };

  let sequence = input.nextEventSequence;
  const outcomeEvent: PipelineEvent = {
    id: outcomeEventId,
    runId: run.id,
    sequence: sequence++,
    eventType: "outcome.handoff",
    actorType: request.actorType,
    actorId: request.actorId,
    assignmentId: sourceAssignment.id,
    outcomeId,
    fromPhase: run.phase,
    toPhase: request.targetRun.phase,
    payloadVersion: 1,
    payload: {
      action: "handoff",
      status: "progress",
      reason: request.reason,
      progressFingerprint: request.progressFingerprint,
      targetAgent: child.targetAgent,
      promotedToKind: request.targetRun.kind,
    },
    idempotencyKey: `${request.idempotencyKey}:source-outcome`,
    occurredAt: now,
    observedAt: now,
  };
  const promotionEvent: PipelineEvent = {
    id: promotionEventId,
    runId: run.id,
    sequence: sequence++,
    eventType: "pipeline.promoted",
    actorType: request.actorType,
    actorId: request.actorId,
    assignmentId: child.id,
    outcomeId,
    fromPhase: run.phase,
    toPhase: request.targetRun.phase,
    payloadVersion: 2,
    payload: {
      fromKind: "default",
      fromPhase: run.phase,
      toKind: request.targetRun.kind,
      toPhase: request.targetRun.phase,
      startKind: request.startKind,
      reason: request.reason,
      sourceMessageTs: request.sourceMessageTs,
      sourceAssignmentId: sourceAssignment.id,
    },
    idempotencyKey: request.idempotencyKey,
    occurredAt: now,
    observedAt: now,
  };
  const seedEvents = (request.seedEvents ?? []).map((event) => ({
    ...event,
    runId: run.id,
    sequence: sequence++,
    payload: { ...event.payload },
  }));
  const dispatchPayloads = [
    request.dispatchPayload,
    ...(request.additionalDispatchPayloads ?? []),
  ];
  const outbox = childAssignments.map((assignment, index): PipelineOutboxRecord => ({
      id: generateId(),
      runId: run.id,
      assignmentId: assignment.id,
      eventType: "assignment.dispatch",
      payload: {
        assignmentId: assignment.id,
        targetAgent: assignment.targetAgent,
        parentAssignmentId: sourceAssignment.id,
        ...dispatchPayloads[index],
      },
      status: "pending",
      attempts: 0,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey: `dispatch:${request.idempotencyKey}:${index}`,
      createdAt: now,
      deliveredAt: null,
      lastError: null,
    }));

  return {
    kind: "commit",
    receipt: {
      status: "accepted",
      runVersion: newVersion,
      assignmentId: child.id,
      outcomeId,
      eventId: promotionEventId,
      reason: request.reason,
    },
    updatedRun,
    updatedSource,
    childAssignments,
    sourceOutcome,
    events: [outcomeEvent, promotionEvent, ...seedEvents],
    outbox,
  };
}

function rejected(
  run: DefaultRun,
  assignmentId: string,
  reason: string,
): DefaultPromotionDecision {
  return {
    kind: "receipt",
    receipt: {
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId,
      reason,
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
