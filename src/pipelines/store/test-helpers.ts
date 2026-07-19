import type { AssignmentCreate, ProductRun } from "../types.ts";
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

export function makeAssignmentCreate(
  overrides: Partial<AssignmentCreate> = {},
): AssignmentCreate {
  return {
    id: "asg-1",
    runId: "run-1",
    parentAssignmentId: null,
    sourceAgent: "system",
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
