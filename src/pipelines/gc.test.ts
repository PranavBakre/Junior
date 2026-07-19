import { describe, expect, it } from "bun:test";
import { fakeClock } from "../time/clock.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import { makeProductRun } from "./store/test-helpers.ts";
import { gcTerminalPipelineHistory, MS_PER_DAY } from "./gc.ts";

describe("gcTerminalPipelineHistory", () => {
  it("compacts only terminal runs older than the retention window", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);

    // Old terminal run (eligible).
    await store.createRun(
      makeProductRun({
        id: "old-terminal",
        threadId: "T-old",
        status: "terminal",
        terminalOutcome: "shipped",
        phase: "shipped",
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
    await store.enqueueOutbox({
      id: "ob-old",
      runId: "old-terminal",
      assignmentId: null,
      eventType: "assignment.dispatch",
      payload: { big: "payload", prompt: "x".repeat(200) },
      idempotencyKey: "ob-old",
    });
    await store.markOutboxDelivered("ob-old");
    await store.appendEvent({
      id: "ev-old",
      runId: "old-terminal",
      eventType: "outcome.accepted",
      actorType: "system",
      actorId: "test",
      assignmentId: null,
      outcomeId: null,
      fromPhase: "building",
      toPhase: "shipped",
      payloadVersion: 1,
      payload: { verbose: true, details: "lots of text" },
      idempotencyKey: "ev-old",
      occurredAt: 1000,
      observedAt: 1000,
    });

    // Active run (must never be touched).
    await store.createRun(
      makeProductRun({
        id: "active-run",
        threadId: "T-active",
        status: "active",
        phase: "building",
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
    await store.enqueueOutbox({
      id: "ob-active",
      runId: "active-run",
      assignmentId: null,
      eventType: "assignment.dispatch",
      payload: { keep: "me" },
      idempotencyKey: "ob-active",
    });
    await store.markOutboxDelivered("ob-active");

    // Recent terminal run (inside retention window).
    const recentUpdatedAt = 1000 + 10 * MS_PER_DAY;
    await store.createRun(
      makeProductRun({
        id: "recent-terminal",
        threadId: "T-recent",
        status: "terminal",
        terminalOutcome: "abandoned",
        phase: "abandoned",
        createdAt: recentUpdatedAt,
        updatedAt: recentUpdatedAt,
      }),
    );
    await store.enqueueOutbox({
      id: "ob-recent",
      runId: "recent-terminal",
      assignmentId: null,
      eventType: "assignment.dispatch",
      payload: { recent: true },
      idempotencyKey: "ob-recent",
    });
    await store.markOutboxDelivered("ob-recent");

    // Advance past 90-day retention from the old run, but not past recent.
    clock.set(1000 + 91 * MS_PER_DAY);

    const report = await gcTerminalPipelineHistory({
      store,
      retentionDays: 90,
      clock,
    });

    expect(report.examined).toBe(1);
    expect(report.runsCompacted).toBe(1);
    expect(report.outboxCompacted).toBe(1);
    expect(report.eventsCompacted).toBe(1);
    expect(report.skippedActive).toBe(0);

    const oldOutbox = await store.listOutbox("old-terminal");
    expect(oldOutbox[0]!.payload).toEqual({ compacted: true });

    const oldEvents = await store.listEvents("old-terminal");
    expect(oldEvents[0]!.payload.compacted).toBe(true);
    expect(oldEvents[0]!.payload.eventType).toBe("outcome.accepted");

    // Active and recent terminal payloads preserved.
    const activeOutbox = await store.listOutbox("active-run");
    expect(activeOutbox[0]!.payload).toEqual({ keep: "me" });

    const recentOutbox = await store.listOutbox("recent-terminal");
    expect(recentOutbox[0]!.payload).toEqual({ recent: true });
  });

  it("is a no-op when no terminal runs are old enough", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(
      makeProductRun({
        id: "fresh",
        status: "terminal",
        terminalOutcome: "shipped",
        phase: "shipped",
        updatedAt: 1000,
      }),
    );
    clock.set(1000 + 10 * MS_PER_DAY);
    const report = await gcTerminalPipelineHistory({
      store,
      retentionDays: 90,
      clock,
    });
    expect(report.examined).toBe(0);
    expect(report.runsCompacted).toBe(0);
  });
});
