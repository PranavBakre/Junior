import type {
  AssignmentCreate,
  BugRun,
  DefaultRunPromotionInput,
  DefaultRun,
  ProductRun,
} from "../types.ts";
import { PIPELINE_DEFINITION_VERSION } from "../types.ts";

export function makeProductRun(
  overrides: Partial<ProductRun> = {},
): ProductRun {
  const now = overrides.createdAt ?? 1_000;
  return {
    id: "run-1",
    kind: "product",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    channelId: "C1",
    threadId: "T1",
    phase: "building",
    status: "active",
    ownerAgent: "build",
    repoRefs: ["example-backend"],
    acceptanceCriteria: ["works"],
    artifactRefs: [],
    blockerRefs: [],
    activeAttemptId: null,
    stateVersion: 0,
    deadlineAt: null,
    terminalOutcome: null,
    terminalReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeBugRun(overrides: Partial<BugRun> = {}): BugRun {
  const now = overrides.createdAt ?? 1_000;
  return {
    id: "bug-run-1",
    kind: "bug",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    channelId: "CBUGS",
    threadId: "TBUG",
    phase: "intake",
    status: "active",
    ownerAgent: "lead",
    repoRefs: ["example-backend"],
    acceptanceCriteria: [],
    artifactRefs: [],
    blockerRefs: [],
    activeAttemptId: null,
    stateVersion: 0,
    deadlineAt: null,
    terminalOutcome: null,
    terminalReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeDefaultRun(
  overrides: Partial<DefaultRun> = {},
): DefaultRun {
  const now = overrides.createdAt ?? 1_000;
  return {
    id: "default-run-1",
    kind: "default",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    channelId: "C1",
    threadId: "T-default",
    phase: "working",
    status: "active",
    ownerAgent: "default",
    repoRefs: [],
    acceptanceCriteria: [],
    artifactRefs: [],
    blockerRefs: [],
    activeAttemptId: null,
    stateVersion: 0,
    deadlineAt: null,
    terminalOutcome: null,
    terminalReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeAssignmentCreate(
  overrides: Partial<AssignmentCreate> = {},
): AssignmentCreate {
  return {
    id: "asg-1",
    runId: "run-1",
    parentAssignmentId: null,
    sourceAgent: "system",
    sourceSlackUserId: null,
    targetAgent: "build",
    objective: "build it",
    contextRefs: [],
    artifactRefs: [],
    acceptanceCriteria: [],
    mutationScope: [],
    dependsOn: [],
    attempt: 1,
    attemptId: null,
    candidateRevisionDigest: null,
    deadlineAt: null,
    idempotencyKey: "asg-idem-1",
    ...overrides,
  };
}

export function makeDefaultPromotionInput(
  overrides: Partial<DefaultRunPromotionInput> = {},
): DefaultRunPromotionInput {
  const targetRun = makeProductRun({
    id: "default-run-1",
    threadId: "T-default",
    channelId: "C1",
    ownerAgent: "default",
    repoRefs: ["example-backend"],
    phase: "ready-to-build",
  });
  return {
    runId: "default-run-1",
    sourceAssignmentId: "default-asg-1",
    expectedRunVersion: 0,
    targetRun,
    childAssignment: makeAssignmentCreate({
      id: "product-asg-1",
      runId: "default-run-1",
      parentAssignmentId: "default-asg-1",
      sourceAgent: "default",
      targetAgent: "build",
      objective: "build it",
      idempotencyKey: "product-promoted-asg-1",
    }),
    reason: "coordination now needs build and review",
    progressFingerprint: "promote-product-build",
    actorType: "agent",
    actorId: "default",
    startKind: "build",
    sourceMessageTs: "1700000000.1",
    idempotencyKey: "pipeline.promoted:test-default-product",
    ...overrides,
  };
}
