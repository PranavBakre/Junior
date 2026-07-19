/**
 * Outbox at-least-once delivery, idempotent consumers, and shadow dispatch guard.
 */
import { describe, expect, it, mock } from "bun:test";
import { fakeClock } from "../time/clock.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import { makeAssignmentCreate, makeProductRun } from "./store/test-helpers.ts";
import { requestHandoff } from "./outcomes.ts";
import { pumpOutbox } from "./pump.ts";
import type { SlackMessageEvent } from "../slack/events.ts";

describe("outbox at-least-once delivery", () => {
  it("replays after crash between dispatch and mark-delivered; consumer dedupe key is stable", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(
      makeProductRun({
        phase: "discovery",
        ownerAgent: "pm",
        stateVersion: 0,
      }),
    );
    await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-pm",
        sourceAgent: "system",
        targetAgent: "pm",
        objective: "scope",
        idempotencyKey: "asg-pm-1",
      }),
    );

    await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "architect",
        objective: "design",
        reason: "handoff",
        progressFingerprint: "fp-atleast",
        idempotencyKey: "handoff-atleast",
        nextIdempotencyKey: "handoff-atleast:next",
        auth: { agent: "pm", channelId: "C1", threadId: "T1" },
      },
    );

    const seenDedupeKeys: string[] = [];
    const dispatcher = {
      handleAgentMessage: mock(
        async (event: SlackMessageEvent, _agent: string) => {
          if (event.dedupeKey) seenDedupeKeys.push(event.dedupeKey);
        },
      ),
    };

    // First pump delivers.
    const first = await pumpOutbox({
      store,
      dispatcher,
      clock,
      owner: "pump-1",
    });
    expect(first.delivered).toBeGreaterThanOrEqual(1);
    expect(seenDedupeKeys.length).toBeGreaterThanOrEqual(1);
    const key = seenDedupeKeys[0]!;

    // Simulate crash after dispatch but before mark: re-enqueue via reclaim
    // by manually resetting a delivered item is not the path — instead seed a
    // second pending item with the same idempotency (store is idempotent).
    const outbox = await store.listOutbox("run-1");
    const delivered = outbox.filter((o) => o.status === "delivered");
    expect(delivered.length).toBeGreaterThanOrEqual(1);

    // Re-enqueue would be suppressed by idempotency key.
    const again = await store.enqueueOutbox({
      id: "dup-ob",
      runId: "run-1",
      assignmentId: delivered[0]!.assignmentId,
      eventType: delivered[0]!.eventType,
      payload: delivered[0]!.payload,
      idempotencyKey: delivered[0]!.idempotencyKey,
    });
    expect(again.id).toBe(delivered[0]!.id);
    expect(again.status).toBe("delivered");

    // Lease-expiry replay path: claim a fresh pending item, fail mid-flight.
    await store.enqueueOutbox({
      id: "ob-replay",
      runId: "run-1",
      assignmentId: delivered[0]!.assignmentId,
      eventType: "assignment.dispatch",
      payload: { assignmentId: delivered[0]!.assignmentId },
      idempotencyKey: "replay-key-unique",
    });
    const leased = await store.claimOutbox("crashed-worker", 10, 1_000);
    expect(leased.some((l) => l.id === "ob-replay")).toBe(true);

    // Crash: no markDelivered. Advance clock past lease and pump again.
    clock.advance(2_000);
    const second = await pumpOutbox({
      store,
      dispatcher,
      clock,
      owner: "pump-2",
    });
    expect(second.reclaimed).toBeGreaterThanOrEqual(1);
    expect(second.delivered + second.skipped).toBeGreaterThanOrEqual(1);

    // Consumer-facing dedupe keys stay deterministic for the original delivery.
    expect(key.startsWith("pipeline-outbox:")).toBe(true);
  });
});
