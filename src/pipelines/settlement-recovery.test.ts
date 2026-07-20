import { describe, expect, it, mock } from "bun:test";
import { createSession } from "../session/types.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { fakeClock } from "../time/clock.ts";
import { reconcileStalePipelineAssignments } from "./recovery.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import { makeAssignmentCreate, makeProductRun } from "./store/test-helpers.ts";

describe("pipeline settlement recovery", () => {
  it("re-wakes a delivered assignment twice, then records one durable escalation", async () => {
    const clock = fakeClock(1_000);
    const pipelineStore = new InMemoryPipelineStore(clock);
    const sessionStore = new InMemorySessionStore();
    await pipelineStore.createRun(makeProductRun({ phase: "building" }));
    await pipelineStore.createAssignment(makeAssignmentCreate({
      id: "asg-stale",
      targetAgent: "build",
      idempotencyKey: "asg-stale-key",
    }));
    await pipelineStore.enqueueOutbox({
      id: "dispatch-stale",
      runId: "run-1",
      assignmentId: "asg-stale",
      eventType: "assignment.dispatch",
      payload: { assignmentId: "asg-stale" },
      idempotencyKey: "dispatch-stale-key",
    });
    const [initial] = await pipelineStore.claimOutbox("pump", 1, 1_000);
    await pipelineStore.markOutboxDelivered(initial!.id);

    const session = createSession("T1", "C1");
    session.activePipelineRunId = "run-1";
    await sessionStore.set(session.threadId, session);
    const audit = mock(async () => undefined);

    for (let attempt = 1; attempt <= 2; attempt++) {
      clock.advance(5 * 60_000 + 1);
      const report = await reconcileStalePipelineAssignments({
        store: pipelineStore,
        sessionReader: sessionStore,
        audit,
        now: clock.now(),
      });
      expect(report.resumesEnqueued).toBe(1);
      const claimed = await pipelineStore.claimOutbox(`pump-${attempt}`, 10, 1_000);
      const recovery = claimed.find((item) =>
        item.idempotencyKey === `pipeline-recovery:asg-stale:${attempt}`
      );
      expect(recovery).toBeDefined();
      await pipelineStore.markOutboxDelivered(recovery!.id);
    }

    clock.advance(5 * 60_000 + 1);
    const exhausted = await reconcileStalePipelineAssignments({
      store: pipelineStore,
      sessionReader: sessionStore,
      audit,
      now: clock.now(),
    });
    expect(exhausted.escalationsRecorded).toBe(1);
    expect(await pipelineStore.listOutcomes("asg-stale")).toHaveLength(1);
    expect((await pipelineStore.getRun("run-1"))?.status).toBe("needs-human");
    expect(audit).toHaveBeenCalledTimes(1);

    const repeated = await reconcileStalePipelineAssignments({
      store: pipelineStore,
      sessionReader: sessionStore,
      audit,
      now: clock.now(),
    });
    expect(repeated.escalationsRecorded).toBe(0);
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
