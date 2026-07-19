import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeClock } from "../../time/clock.ts";
import { SqlitePipelineStore } from "./sqlite.ts";
import { makeAssignmentCreate, makeProductRun } from "./test-helpers.ts";
import type { AgentOutcome, PipelineAttempt, PipelineGate } from "../types.ts";

function baseOutcome(overrides: Partial<AgentOutcome> = {}): AgentOutcome {
  return {
    assignmentId: "asg-1",
    expectedRunVersion: 0,
    action: "continue_self",
    status: "progress",
    reason: "still working",
    evidenceRefs: ["e1"],
    artifactRefs: [],
    blockers: [],
    checks: [],
    progressFingerprint: "fp-1",
    ...overrides,
  };
}

describe("SqlitePipelineStore", () => {
  let tmpDir: string;
  let store: SqlitePipelineStore;
  const clock = fakeClock(1_000);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-pipeline-"));
    clock.set(1_000);
    store = new SqlitePipelineStore(join(tmpDir, "test.db"), clock);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips runs and assignments", async () => {
    await store.createRun(makeProductRun());
    await store.createAssignment(makeAssignmentCreate());
    const run = await store.getRun("run-1");
    expect(run?.kind).toBe("product");
    expect(run?.threadId).toBe("T1");
    const asg = await store.getAssignment("asg-1");
    expect(asg?.targetAgent).toBe("build");
    expect((await store.getRunByThread("T1"))?.id).toBe("run-1");
  });

  it("is idempotent on assignment idempotency keys", async () => {
    await store.createRun(makeProductRun());
    const a1 = await store.createAssignment(makeAssignmentCreate());
    const a2 = await store.createAssignment(
      makeAssignmentCreate({ id: "different-id" }),
    );
    expect(a2.id).toBe(a1.id);
  });

  it("returns duplicate receipt for outcome idempotency keys", async () => {
    await store.createRun(makeProductRun());
    await store.createAssignment(makeAssignmentCreate());

    const first = await store.recordOutcomeTransaction({
      outcome: baseOutcome(),
      toPhase: "aggregate-verification",
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "out-1",
    });
    expect(first.status).toBe("accepted");

    const second = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        expectedRunVersion: 1,
        progressFingerprint: "fp-2",
        reason: "retry",
      }),
      toPhase: "pr-open",
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "out-1",
    });
    expect(second.status).toBe("duplicate");
    expect((await store.getRun("run-1"))?.stateVersion).toBe(1);
  });

  it("rejects CAS conflicts on state_version", async () => {
    await store.createRun(makeProductRun());
    await store.createAssignment(makeAssignmentCreate());

    const accepted = await store.recordOutcomeTransaction({
      outcome: baseOutcome(),
      toPhase: "aggregate-verification",
      actorType: "agent",
      actorId: "build",
    });
    expect(accepted.status).toBe("accepted");

    const stale = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        expectedRunVersion: 0,
        progressFingerprint: "fp-2",
        evidenceRefs: ["e2"],
      }),
      toPhase: "pr-open",
      actorType: "agent",
      actorId: "build",
    });
    expect(stale.status).toBe("rejected");
    expect(stale.reason).toMatch(/state version conflict/i);
  });

  it("rejects mutation on terminal runs (immutability)", async () => {
    await store.createRun(
      makeProductRun({ phase: "ready-for-human-merge" }),
    );
    await store.createAssignment(makeAssignmentCreate());

    const ship = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        action: "complete",
        status: "succeeded",
        reason: "all PRs merged",
      }),
      toPhase: "shipped",
      actorType: "human",
      actorId: "U1",
    });
    expect(ship.status).toBe("accepted");
    expect((await store.getRun("run-1"))?.terminalOutcome).toBe("shipped");

    const again = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        expectedRunVersion: 1,
        action: "complete",
        status: "succeeded",
        progressFingerprint: "fp-2",
        evidenceRefs: ["e2"],
        reason: "cleanup twice",
      }),
      actorType: "system",
      actorId: "system",
    });
    expect(again.status).toBe("rejected");
    expect(again.reason).toMatch(/terminal/i);
  });

  it("invalidates aggregate gates when any revision member changes", async () => {
    await store.createRun(makeProductRun({ activeAttemptId: "att-1" }));
    const attempt: PipelineAttempt = {
      id: "att-1",
      runId: "run-1",
      ordinal: 1,
      revisionDigest: null,
      status: "open",
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: 1000,
      finishedAt: null,
    };
    await store.createAttempt(attempt);

    const first = await store.replaceAttemptRevision("att-1", [
      {
        memberKey: "backend",
        repoRef: "example-backend",
        branch: "feature/x",
        headSha: "sha-a",
      },
      {
        memberKey: "frontend",
        repoRef: "example-frontend",
        branch: "feature/x",
        headSha: "sha-f",
      },
    ]);

    // Review on SHA A, validation on SHA B must not share aggregate pass —
    // we model that by binding gates to subjectSha and invalidating on digest change.
    await store.upsertGate({
      id: "gate-review",
      runId: "run-1",
      attemptId: "att-1",
      memberKey: "backend",
      githubResourceId: null,
      gateKind: "review",
      status: "passed",
      subjectSha: "sha-a",
      evidenceRef: "review-1",
      provider: "claude",
      model: null,
      agentName: "review",
      updatedAt: 1000,
    });
    await store.upsertGate({
      id: "gate-validation",
      runId: "run-1",
      attemptId: "att-1",
      memberKey: "backend",
      githubResourceId: null,
      gateKind: "validation",
      // Different subject SHA from review — aggregate must not stay passed
      // after any member of the vector changes.
      status: "passed",
      subjectSha: "sha-b",
      evidenceRef: "val-1",
      provider: "claude",
      model: null,
      agentName: "reproducer",
      updatedAt: 1000,
    } satisfies PipelineGate);
    await store.upsertGate({
      id: "gate-agg",
      runId: "run-1",
      attemptId: "att-1",
      memberKey: null,
      githubResourceId: null,
      gateKind: "aggregate",
      status: "passed",
      subjectSha: first.digest,
      evidenceRef: null,
      provider: null,
      model: null,
      agentName: null,
      updatedAt: 1000,
    });

    const second = await store.replaceAttemptRevision("att-1", [
      {
        memberKey: "backend",
        repoRef: "example-backend",
        branch: "feature/x",
        headSha: "sha-a",
      },
      {
        memberKey: "frontend",
        repoRef: "example-frontend",
        branch: "feature/x",
        headSha: "sha-f2",
      },
    ]);
    expect(second.invalidatedGateCount).toBe(3);
    const gates = await store.listGates("att-1");
    expect(gates.every((g) => g.status === "invalidated")).toBe(true);
  });

  it("persists outcomes, events, and outbox atomically on handoff", async () => {
    await store.createRun(makeProductRun({ phase: "pr-open" }));
    await store.createAssignment(makeAssignmentCreate());

    const receipt = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        action: "handoff",
        status: "progress",
        targetAgent: "review",
        reason: "ready for review",
        nextAssignment: {
          parentAssignmentId: "asg-1",
          targetAgent: "review",
          objective: "review PR",
          contextRefs: [],
          artifactRefs: [],
          acceptanceCriteria: [],
          mutationScope: [],
          dependsOn: [],
          attempt: 1,
          attemptId: null,
          candidateRevisionDigest: null,
          deadlineAt: null,
          idempotencyKey: "handoff-review-1",
        },
      }),
      toPhase: "reviewing",
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "tx-1",
    });
    expect(receipt.status).toBe("accepted");
    expect(receipt.runVersion).toBe(1);

    const outcomes = await store.listOutcomes("asg-1");
    expect(outcomes).toHaveLength(1);

    const events = await store.listEvents("run-1");
    expect(events).toHaveLength(1);
    expect(events[0]!.fromPhase).toBe("pr-open");
    expect(events[0]!.toPhase).toBe("reviewing");

    const outbox = await store.listOutbox("run-1");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe("assignment.dispatch");
  });

  it("claims and reclaims outbox with fake clock", async () => {
    await store.createRun(makeProductRun());
    await store.enqueueOutbox({
      id: "ob-1",
      runId: "run-1",
      assignmentId: null,
      eventType: "assignment.dispatch",
      payload: {},
      idempotencyKey: "ob-1",
    });

    const claimed = await store.claimOutbox("w1", 5, 2_000);
    expect(claimed).toHaveLength(1);

    clock.advance(2_001);
    expect(await store.reclaimExpiredOutboxLeases(clock.now())).toBe(1);

    const again = await store.claimOutbox("w2", 5, 2_000);
    expect(again[0]!.leaseOwner).toBe("w2");
    await store.markOutboxDelivered(again[0]!.id);
    expect((await store.listOutbox("run-1"))[0]!.status).toBe("delivered");
  });
});
