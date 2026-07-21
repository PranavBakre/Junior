import { describe, expect, it } from "bun:test";
import { fakeClock } from "../../time/clock.ts";
import { InMemoryPipelineStore } from "./memory.ts";
import {
  makeAssignmentCreate,
  makeDefaultPromotionInput,
  makeDefaultRun,
  makeProductRun,
} from "./test-helpers.ts";
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

describe("InMemoryPipelineStore", () => {
  it("promotes a default run in place with source outcome, child, and dispatch", async () => {
    const store = new InMemoryPipelineStore(fakeClock(2_000));
    await store.createRun(makeDefaultRun());
    await store.createAssignment(makeAssignmentCreate({
      id: "default-asg-1",
      runId: "default-run-1",
      targetAgent: "default",
      idempotencyKey: "default-asg-key",
    }));

    const receipt = await store.promoteDefaultRunTransaction(
      makeDefaultPromotionInput(),
    );
    expect(receipt.status).toBe("accepted");
    expect(await store.getRun("default-run-1")).toMatchObject({
      id: "default-run-1",
      kind: "product",
      stateVersion: 1,
      createdAt: 1_000,
    });
    expect(await store.getAssignment("default-asg-1")).toMatchObject({ status: "completed" });
    expect(await store.getAssignment("product-asg-1")).toMatchObject({
      parentAssignmentId: "default-asg-1",
      targetAgent: "build",
    });
    expect(await store.listOutcomes("default-asg-1")).toHaveLength(1);
    expect((await store.listEvents("default-run-1")).map((event) => event.eventType)).toEqual([
      "outcome.handoff",
      "pipeline.promoted",
    ]);
    expect(await store.listOutbox("default-run-1")).toHaveLength(1);

    const duplicate = await store.promoteDefaultRunTransaction(
      makeDefaultPromotionInput(),
    );
    expect(duplicate.status).toBe("duplicate");
    expect(await store.listOutcomes("default-asg-1")).toHaveLength(1);
  });

  it("delegates to a child and resumes the waiting parent on child completion", async () => {
    const store = new InMemoryPipelineStore(fakeClock(2_000));
    await store.createRun(makeDefaultRun());
    await store.createAssignment(makeAssignmentCreate({
      id: "default-asg-1",
      runId: "default-run-1",
      targetAgent: "default",
      idempotencyKey: "default-asg-key",
    }));
    const delegated = await store.recordOutcomeTransaction({
      outcome: {
        ...baseOutcome({
          assignmentId: "default-asg-1",
          action: "delegate",
          targetAgent: "review",
          progressFingerprint: "delegate-review",
        }),
        nextAssignment: makeAssignmentCreate({
          id: "review-asg-1",
          runId: "default-run-1",
          parentAssignmentId: "default-asg-1",
          sourceAgent: "default",
          targetAgent: "review",
          idempotencyKey: "review-child-key",
        }),
      },
      actorType: "agent",
      actorId: "default",
      idempotencyKey: "delegate-review",
    });
    expect(delegated.status).toBe("accepted");
    expect(await store.getAssignment("default-asg-1")).toMatchObject({ status: "waiting" });

    const duplicateDelegation = await store.recordOutcomeTransaction({
      outcome: {
        ...baseOutcome({
          assignmentId: "default-asg-1",
          expectedRunVersion: 1,
          action: "delegate",
          targetAgent: "build",
          progressFingerprint: "delegate-again",
        }),
        nextAssignment: makeAssignmentCreate({
          id: "unexpected-asg",
          runId: "default-run-1",
          parentAssignmentId: "default-asg-1",
          targetAgent: "build",
          idempotencyKey: "unexpected-child-key",
        }),
      },
      actorType: "agent",
      actorId: "default",
      idempotencyKey: "delegate-again",
    });
    expect(duplicateDelegation.status).toBe("rejected");

    const completed = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        assignmentId: "review-asg-1",
        expectedRunVersion: 1,
        action: "complete",
        status: "succeeded",
        reason: "review complete",
        progressFingerprint: "review-complete",
      }),
      actorType: "agent",
      actorId: "review",
      idempotencyKey: "review-complete",
    });
    expect(completed.status).toBe("accepted");
    expect(await store.getAssignment("default-asg-1")).toMatchObject({ status: "pending" });
    expect((await store.listOutbox("default-run-1")).at(-1)).toMatchObject({
      eventType: "assignment.resume",
      assignmentId: "default-asg-1",
    });
    expect(await store.getRun("default-run-1")).toMatchObject({
      phase: "working",
      status: "active",
    });
  });

  it("completes a default run when the final handoff owner completes", async () => {
    const store = new InMemoryPipelineStore(fakeClock(2_000));
    await store.createRun(makeDefaultRun());
    await store.createAssignment(makeAssignmentCreate({
      id: "default-asg-1",
      runId: "default-run-1",
      targetAgent: "default",
      idempotencyKey: "default-asg-key",
    }));
    const handoff = await store.recordOutcomeTransaction({
      outcome: {
        ...baseOutcome({
          assignmentId: "default-asg-1",
          action: "handoff",
          targetAgent: "build",
          progressFingerprint: "handoff-build",
        }),
        nextAssignment: makeAssignmentCreate({
          id: "build-asg",
          runId: "default-run-1",
          parentAssignmentId: "default-asg-1",
          sourceAgent: "default",
          targetAgent: "build",
          idempotencyKey: "build-asg-key",
        }),
      },
      actorType: "agent",
      actorId: "default",
      idempotencyKey: "handoff-build",
    });
    expect(handoff.status).toBe("accepted");

    const completed = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        assignmentId: "build-asg",
        expectedRunVersion: 1,
        action: "complete",
        status: "succeeded",
        reason: "build completed",
        progressFingerprint: "build-completed",
      }),
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "build-completed",
    });
    expect(completed.status).toBe("accepted");
    expect(await store.getRun("default-run-1")).toMatchObject({
      phase: "completed",
      status: "terminal",
      terminalOutcome: "completed",
    });
  });

  it("resumes the waiting delegator after a descendant handoff completes", async () => {
    const store = new InMemoryPipelineStore(fakeClock(2_000));
    await store.createRun(makeDefaultRun());
    await store.createAssignment(makeAssignmentCreate({
      id: "root-asg",
      runId: "default-run-1",
      targetAgent: "default",
      idempotencyKey: "root-key",
    }));
    await store.recordOutcomeTransaction({
      outcome: {
        ...baseOutcome({
          assignmentId: "root-asg",
          action: "delegate",
          targetAgent: "review",
          progressFingerprint: "root-delegates",
        }),
        nextAssignment: makeAssignmentCreate({
          id: "review-asg",
          runId: "default-run-1",
          parentAssignmentId: "root-asg",
          sourceAgent: "default",
          targetAgent: "review",
          idempotencyKey: "review-key",
        }),
      },
      actorType: "agent",
      actorId: "default",
      idempotencyKey: "root-delegates",
    });
    await store.recordOutcomeTransaction({
      outcome: {
        ...baseOutcome({
          assignmentId: "review-asg",
          expectedRunVersion: 1,
          action: "handoff",
          targetAgent: "build",
          progressFingerprint: "review-handoff",
        }),
        nextAssignment: makeAssignmentCreate({
          id: "build-asg",
          runId: "default-run-1",
          parentAssignmentId: "review-asg",
          sourceAgent: "review",
          targetAgent: "build",
          idempotencyKey: "build-key",
        }),
      },
      actorType: "agent",
      actorId: "review",
      idempotencyKey: "review-handoff",
    });

    const completed = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        assignmentId: "build-asg",
        expectedRunVersion: 2,
        action: "complete",
        status: "succeeded",
        progressFingerprint: "build-complete",
      }),
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "build-complete",
    });

    expect(completed.status).toBe("accepted");
    expect(await store.getAssignment("root-asg")).toMatchObject({ status: "pending" });
    expect((await store.listOutbox("default-run-1")).at(-1)).toMatchObject({
      eventType: "assignment.resume",
      assignmentId: "root-asg",
    });
  });
  it("creates and fetches runs by id and thread", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const run = makeProductRun();
    await store.createRun(run);
    expect((await store.getRun("run-1"))?.phase).toBe("building");
    expect((await store.getRunByThread("T1"))?.id).toBe("run-1");
  });

  it("is idempotent on assignment idempotency keys", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await store.createRun(makeProductRun());
    const a1 = await store.createAssignment(makeAssignmentCreate());
    const a2 = await store.createAssignment(
      makeAssignmentCreate({ id: "asg-other" }),
    );
    expect(a2.id).toBe(a1.id);
  });

  it("returns duplicate receipt for outcome idempotency keys", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
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
    expect(first.runVersion).toBe(1);

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
    expect(second.runVersion).toBe(1);

    const run = await store.getRun("run-1");
    expect(run?.phase).toBe("aggregate-verification");
    expect(run?.stateVersion).toBe(1);
  });

  it("rejects CAS conflicts on state_version", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
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

  it("rejects mutation on terminal runs", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await store.createRun(
      makeProductRun({
        phase: "ready-for-human-merge",
        stateVersion: 0,
      }),
    );
    await store.createAssignment(makeAssignmentCreate());

    const ship = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        action: "complete",
        status: "succeeded",
        reason: "merged",
      }),
      toPhase: "shipped",
      actorType: "human",
      actorId: "U1",
    });
    expect(ship.status).toBe("accepted");
    expect((await store.getRun("run-1"))?.status).toBe("terminal");

    const again = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        expectedRunVersion: 1,
        action: "complete",
        status: "succeeded",
        progressFingerprint: "fp-2",
        evidenceRefs: ["e2"],
        reason: "cleanup again",
      }),
      toPhase: "shipped",
      actorType: "system",
      actorId: "system",
    });
    expect(again.status).toBe("rejected");
    expect(again.reason).toMatch(/terminal/i);
  });

  it("invalidates aggregate gates when revision vector changes", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
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
    expect(first.invalidatedGateCount).toBe(0);

    const reviewGate: PipelineGate = {
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
    };
    const validationGate: PipelineGate = {
      id: "gate-validation",
      runId: "run-1",
      attemptId: "att-1",
      memberKey: "backend",
      githubResourceId: null,
      gateKind: "validation",
      status: "passed",
      subjectSha: "sha-a",
      evidenceRef: "val-1",
      provider: "claude",
      model: null,
      agentName: "reproducer",
      updatedAt: 1000,
    };
    const aggregateGate: PipelineGate = {
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
    };
    await store.upsertGate(reviewGate);
    await store.upsertGate(validationGate);
    await store.upsertGate(aggregateGate);

    // Change frontend SHA only — must invalidate all aggregate gates.
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
    expect(second.digest).not.toBe(first.digest);
    expect(second.invalidatedGateCount).toBe(3);

    const gates = await store.listGates("att-1");
    expect(gates.every((g) => g.status === "invalidated")).toBe(true);

    const att = await store.getAttempt("att-1");
    expect(att?.status).toBe("invalidated");
    expect(att?.revisionDigest).toBe(second.digest);
  });

  it("claims, delivers, and reclaims outbox leases", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeProductRun());
    await store.enqueueOutbox({
      id: "ob-1",
      runId: "run-1",
      assignmentId: null,
      eventType: "assignment.dispatch",
      payload: { x: 1 },
      idempotencyKey: "ob-idem-1",
    });

    const claimed = await store.claimOutbox("worker-a", 10, 5_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("leased");
    expect(claimed[0]!.leaseOwner).toBe("worker-a");

    // Still leased — reclaim should not steal before expiry.
    expect(await store.reclaimExpiredOutboxLeases(clock.now())).toBe(0);

    clock.advance(5_001);
    expect(await store.reclaimExpiredOutboxLeases(clock.now())).toBe(1);

    const reclaimed = await store.claimOutbox("worker-b", 10, 5_000);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.leaseOwner).toBe("worker-b");

    await store.markOutboxDelivered(reclaimed[0]!.id);
    const listed = await store.listOutbox("run-1");
    expect(listed[0]!.status).toBe("delivered");
  });

  it("registers the same PR independently across pipeline runs", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await store.createRun(makeProductRun({ id: "run-a", threadId: "T-a" }));
    await store.createRun(makeProductRun({ id: "run-b", threadId: "T-b" }));

    const register = (
      runId: string,
      assignmentId: string,
      expectedHeadSha = "a".repeat(40),
    ) =>
      store.commitPrRegistration({
        registration: {
          runId,
          assignmentId,
          owner: "example",
          repo: "backend",
          number: 42,
          role: "candidate",
          workstreamKey: "backend",
          attemptId: null,
          expectedHeadSha,
        },
        actorId: "default",
        runPhase: "pr-open",
        now: 1000,
      });

    const first = await register("run-a", "asg-a");
    const second = await register("run-b", "asg-b");
    const revised = await register("run-a", "asg-a", "b".repeat(40));

    expect(second.eventId).not.toBe(first.eventId);
    expect(revised.eventId).not.toBe(first.eventId);
    expect(await store.listPipelineGitHubResources("run-a", true)).toHaveLength(
      1,
    );
    expect(await store.listPipelineGitHubResources("run-b", true)).toHaveLength(
      1,
    );
    expect(
      (await store.listPipelineGitHubResources("run-a", true))[0]
        ?.expectedHeadSha,
    ).toBe("b".repeat(40));
  });

  it("creates next assignment + outbox on handoff", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
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
    });
    expect(receipt.status).toBe("accepted");

    const assignments = await store.listAssignments("run-1");
    expect(assignments).toHaveLength(2);
    expect(assignments.some((a) => a.targetAgent === "review")).toBe(true);

    const outbox = await store.listOutbox("run-1");
    expect(outbox.some((o) => o.eventType === "assignment.dispatch")).toBe(
      true,
    );
  });
});
