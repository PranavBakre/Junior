import { describe, expect, it, mock } from "bun:test";
import { fakeClock } from "../time/clock.ts";
import { pumpOutbox } from "./pump.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import {
  makeAssignmentCreate,
  makeDefaultRun,
  makeProductRun,
} from "./store/test-helpers.ts";

describe("pipeline wait deadline", () => {
  it("durably escalates and audits when a wait expires", async () => {
    const clock = fakeClock(1_000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeDefaultRun());
    await store.createAssignment(makeAssignmentCreate({
      id: "wait-asg",
      runId: "default-run-1",
      targetAgent: "default",
      idempotencyKey: "wait-asg-key",
    }));
    const waited = await store.recordOutcomeTransaction({
      outcome: {
        assignmentId: "wait-asg",
        expectedRunVersion: 0,
        action: "wait",
        status: "blocked",
        reason: "wait for checks",
        evidenceRefs: [],
        artifactRefs: [],
        blockers: [],
        checks: [],
        progressFingerprint: "wait-checks",
        wait: { conditionName: "github-checks", deadlineAt: 2_000 },
      },
      actorType: "agent",
      actorId: "default",
      idempotencyKey: "wait-checks",
    });
    expect(waited.status).toBe("waiting");

    clock.advance(1_001);
    const audit = mock(async () => undefined);
    const report = await pumpOutbox({
      store,
      clock,
      dispatcher: { handleAgentMessage: async () => undefined },
      audit,
    });

    expect(report.delivered).toBe(1);
    expect(await store.getRun("default-run-1")).toMatchObject({
      phase: "needs-human",
      status: "needs-human",
    });
    expect(audit).toHaveBeenCalledTimes(1);
  });
});

describe("pipeline escalation audit", () => {
  it("keeps ordinary default-run settlement internal", async () => {
    const clock = fakeClock(1_000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeDefaultRun());
    await store.createAssignment(makeAssignmentCreate({
      id: "default-asg",
      runId: "default-run-1",
      targetAgent: "default",
      idempotencyKey: "default-asg-key",
    }));
    const escalated = await store.recordOutcomeTransaction({
      outcome: {
        assignmentId: "default-asg",
        expectedRunVersion: 0,
        action: "escalate",
        status: "blocked",
        reason: "Need the user to choose a repository",
        evidenceRefs: [],
        artifactRefs: [],
        blockers: [{
          kind: "human_gate",
          detail: "Choose a repository",
        }],
        checks: [],
        progressFingerprint: "default-repo-choice",
      },
      actorType: "agent",
      actorId: "default",
      idempotencyKey: "default-repo-choice",
    });
    expect(escalated.status).toBe("escalated");

    const audit = mock(async () => undefined);
    const report = await pumpOutbox({
      store,
      clock,
      dispatcher: { handleAgentMessage: async () => undefined },
      audit,
    });

    expect(report.delivered).toBe(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it("still publishes typed-pipeline human-gate audits", async () => {
    const clock = fakeClock(1_000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeProductRun());
    await store.createAssignment(makeAssignmentCreate());
    const escalated = await store.recordOutcomeTransaction({
      outcome: {
        assignmentId: "asg-1",
        expectedRunVersion: 0,
        action: "escalate",
        status: "blocked",
        reason: "Need product approval",
        evidenceRefs: [],
        artifactRefs: [],
        blockers: [{
          kind: "human_gate",
          detail: "Approve the product decision",
        }],
        checks: [],
        progressFingerprint: "product-approval",
      },
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "product-approval",
    });
    expect(escalated.status).toBe("escalated");

    const audit = mock(async () => undefined);
    const report = await pumpOutbox({
      store,
      clock,
      dispatcher: { handleAgentMessage: async () => undefined },
      audit,
    });

    expect(report.delivered).toBe(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      channelId: "C1",
      threadId: "T1",
      text: ":raising_hand: Need product approval",
    });
  });
});
