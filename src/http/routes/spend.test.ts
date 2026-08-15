import { describe, expect, it } from "bun:test";
import { USAGE_RETENTION_MS } from "../../lifecycle/cleanup.ts";
import type { NormalizedUsage } from "../../usage/normalize.ts";
import { InMemoryUsageStore } from "../../usage/store/memory.ts";
import { startOfLocalDay } from "../query.ts";
import { handleSpend } from "./spend.ts";

function usage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    sourceKind: "session-turn",
    sourceId: "thread-1:default:1",
    threadId: "thread-1",
    channelId: "C123",
    agentName: "default",
    provider: "opencode",
    providerSessionId: "ses-1",
    pipelineRunId: null,
    assignmentId: null,
    workflowName: null,
    workflowRunId: null,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 12,
    costUsd: 0.01,
    costEstimatedUsd: null,
    numTurns: 1,
    raw: {},
    occurredAt: Date.now(),
    ...overrides,
  };
}

describe("handleSpend", () => {
  it("defaults to today's host-local window", async () => {
    const store = new InMemoryUsageStore();
    const todayStart = startOfLocalDay();
    await store.add(usage({
      sourceId: "today",
      occurredAt: todayStart + 1,
      inputTokens: 4,
    }));
    await store.add(usage({
      sourceId: "yesterday",
      occurredAt: todayStart - 1,
      inputTokens: 99,
    }));

    const response = await handleSpend(store, new URLSearchParams());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      from: number;
      to: number;
      totals: { turns: number; inputTokens: number };
      buckets: Array<{ key: string }>;
    };
    expect(body.from).toBe(todayStart);
    expect(body.to).toBeGreaterThanOrEqual(todayStart);
    expect(body.totals.turns).toBe(1);
    expect(body.totals.inputTokens).toBe(4);
    expect(body.buckets.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects inverted or oversized ranges", async () => {
    const store = new InMemoryUsageStore();
    const inverted = await handleSpend(
      store,
      new URLSearchParams("from=200&to=100"),
    );
    expect(inverted.status).toBe(400);

    const oversized = await handleSpend(
      store,
      new URLSearchParams(`from=0&to=${USAGE_RETENTION_MS + 1}`),
    );
    expect(oversized.status).toBe(400);
  });

  it("groups by the requested key", async () => {
    const store = new InMemoryUsageStore();
    const now = Date.now();
    await store.add(usage({
      sourceId: "t1",
      threadId: "thread-1",
      agentName: "review",
      provider: "claude",
      workflowName: "worklog",
      pipelineRunId: "run-1",
      occurredAt: now,
    }));
    await store.add(usage({
      sourceId: "t2",
      threadId: "thread-2",
      agentName: "build",
      provider: "opencode",
      workflowName: "notes",
      pipelineRunId: "run-2",
      occurredAt: now,
    }));

    const cases: Array<{ groupBy: string; keys: string[] }> = [
      { groupBy: "session", keys: ["thread-1", "thread-2"] },
      { groupBy: "agent", keys: ["build", "review"] },
      { groupBy: "provider", keys: ["claude", "opencode"] },
      { groupBy: "workflow", keys: ["notes", "worklog"] },
      { groupBy: "pipeline", keys: ["run-1", "run-2"] },
    ];

    for (const { groupBy, keys } of cases) {
      const response = await handleSpend(
        store,
        new URLSearchParams({
          from: String(now - 1),
          to: String(now + 1),
          groupBy,
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json() as { buckets: Array<{ key: string }> };
      expect(body.buckets.map((bucket) => bucket.key).sort()).toEqual(keys);
    }
  });
});
