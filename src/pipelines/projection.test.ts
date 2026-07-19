import { describe, expect, it } from "bun:test";
import { projectRunSummary } from "./projection.ts";
import type { Assignment, ProductRun, StoredOutcome } from "./types.ts";
import { PIPELINE_DEFINITION_VERSION } from "./types.ts";

describe("projectRunSummary", () => {
  it("renders a human-readable summary", () => {
    const run: ProductRun = {
      id: "abcdefgh-ijkl",
      kind: "product",
      definitionVersion: PIPELINE_DEFINITION_VERSION,
      channelId: "C1",
      threadId: "T1",
      phase: "reviewing",
      status: "active",
      ownerAgent: "review",
      repoRefs: [],
      acceptanceCriteria: [],
      artifactRefs: [],
      blockerRefs: [],
      activeAttemptId: null,
      stateVersion: 4,
      deadlineAt: null,
      terminalOutcome: null,
      terminalReason: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const assignments: Assignment[] = [
      {
        id: "a1",
        runId: run.id,
        parentAssignmentId: null,
        sourceAgent: "system",
        targetAgent: "review",
        status: "leased",
        objective: "review",
        contextRefs: [],
        artifactRefs: [],
        acceptanceCriteria: [],
        mutationScope: [],
        dependsOn: [],
        attempt: 1,
        attemptId: null,
        candidateRevisionDigest: null,
        deadlineAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        idempotencyKey: "k",
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const outcome: StoredOutcome = {
      id: "o1",
      assignmentId: "a1",
      action: "continue_self",
      status: "progress",
      reason: "reading files",
      evidenceRefs: [],
      artifactRefs: [],
      blockers: [],
      checks: [],
      confidence: null,
      progressFingerprint: "fp",
      createdAt: 0,
    };

    const summary = projectRunSummary(run, assignments, outcome);
    expect(summary.openAssignmentCount).toBe(1);
    expect(summary.humanReadable).toContain("phase=reviewing");
    expect(summary.humanReadable).toContain("owner=review");
    expect(summary.lastOutcomeSummary).toContain("continue_self");
  });
});
