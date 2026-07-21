import { describe, expect, it, mock } from "bun:test";
import { fakeClock } from "../time/clock.ts";
import { pumpOutbox } from "./pump.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import { makeAssignmentCreate, makeDefaultRun } from "./store/test-helpers.ts";

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
