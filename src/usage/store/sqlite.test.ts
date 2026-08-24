import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRunnerUsage, type NormalizedUsage } from "../normalize.ts";
import { SqliteUsageStore } from "./sqlite.ts";
import { InMemoryUsageStore } from "./memory.ts";
import { USAGE_RETENTION_MS } from "../../lifecycle/cleanup.ts";

function usage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    sourceKind: "session-turn",
    sourceId: "thread-1:default:111.1",
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
    costUsd: null,
    costEstimatedUsd: null,
    numTurns: null,
    raw: { input: 10, output: 2 },
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("SqliteUsageStore", () => {
  let tmpDir: string;
  let store: SqliteUsageStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-usage-"));
    store = new SqliteUsageStore(join(tmpDir, "sessions.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sums tokens for the same source_kind + source_id", async () => {
    await store.add(usage({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      raw: { input: 10 },
    }));
    await store.add(usage({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 12,
      costUsd: 0.01,
      occurredAt: 1_700_000_000_500,
      raw: { input: 5 },
    }));

    const row = await store.get("session-turn", "thread-1:default:111.1");
    expect(row).toMatchObject({
      inputTokens: 15,
      outputTokens: 5,
      cacheReadTokens: 4,
      totalTokens: 24,
      costUsd: 0.01,
      costEstimatedUsd: null,
      occurredAt: 1_700_000_000_000,
    });
    expect(Array.isArray(row?.raw.parts)).toBe(true);
  });

  it("stores a missing-usage row with null token fields", async () => {
    const missing = normalizeRunnerUsage(undefined, {
      sourceKind: "session-turn",
      sourceId: "thread-1:default:missing",
      threadId: "thread-1",
      channelId: "C123",
      agentName: "default",
      provider: "opencode",
      providerSessionId: null,
      pipelineRunId: null,
      assignmentId: null,
      workflowName: null,
      workflowRunId: null,
      occurredAt: 1_700_000_000_000,
    });
    await store.add(missing);
    const row = await store.get("session-turn", "thread-1:default:missing");
    expect(row).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      raw: {},
    });
  });

  it("groups rows by agent and session", async () => {
    await store.add(usage({
      sourceId: "t1:default:1",
      threadId: "t1",
      agentName: "default",
      inputTokens: 10,
      outputTokens: 1,
      occurredAt: 1_700_000_100_000,
    }));
    await store.add(usage({
      sourceId: "t1:review:2",
      threadId: "t1",
      agentName: "review",
      inputTokens: 20,
      outputTokens: 4,
      occurredAt: 1_700_000_200_000,
    }));
    await store.add(usage({
      sourceId: "t2:default:3",
      threadId: "t2",
      agentName: "default",
      inputTokens: 5,
      outputTokens: 1,
      occurredAt: 1_700_000_300_000,
    }));

    const byAgent = await store.groupBy({
      from: 1_700_000_000_000,
      to: 1_700_000_400_000,
      groupBy: "agent",
    });
    expect(byAgent.totals).toMatchObject({
      turns: 3,
      inputTokens: 35,
      outputTokens: 6,
      missingUsageTurns: 0,
    });
    expect(byAgent.buckets).toEqual([
      {
        key: "default",
        label: "default",
        turns: 2,
        inputTokens: 15,
        outputTokens: 2,
        costUsd: 0,
        costEstimatedUsd: 0,
      },
      {
        key: "review",
        label: "review",
        turns: 1,
        inputTokens: 20,
        outputTokens: 4,
        costUsd: 0,
        costEstimatedUsd: 0,
      },
    ]);

    const bySession = await store.groupBy({
      from: 1_700_000_000_000,
      to: 1_700_000_400_000,
      groupBy: "session",
    });
    expect(bySession.buckets.map((bucket) => bucket.key)).toEqual(["t1", "t2"]);
  });

  it("groups day buckets in the host local timezone", async () => {
    const occurredAt = new Date(2026, 5, 15, 23, 30, 0).getTime();
    await store.add(usage({
      sourceId: "local-day",
      occurredAt,
    }));
    const result = await store.groupBy({
      from: occurredAt - 1,
      to: occurredAt + 1,
      groupBy: "day",
    });
    const local = new Date(occurredAt);
    const expected = [
      String(local.getFullYear()),
      String(local.getMonth() + 1).padStart(2, "0"),
      String(local.getDate()).padStart(2, "0"),
    ].join("-");
    expect(result.buckets.map((bucket) => bucket.key)).toEqual([expected]);
  });

  it("keeps historical winter and summer day boundaries aligned with JavaScript DST", async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const winter = new Date("2026-01-15T00:30:00-05:00").getTime();
      const summer = new Date("2026-07-15T00:30:00-04:00").getTime();
      await store.add(usage({ sourceId: "dst-winter", occurredAt: winter }));
      await store.add(usage({ sourceId: "dst-summer", occurredAt: summer }));
      const result = await store.groupBy({
        from: winter - 1,
        to: summer + 1,
        groupBy: "day",
      });
      expect(result.buckets.map((bucket) => bucket.key)).toEqual(["2026-01-15", "2026-07-15"]);
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it("matches the in-memory aggregate shape across null fallbacks and filters", async () => {
    const events = [
      usage({ sourceId: "group-a", threadId: null, agentName: null, provider: null, workflowName: null, workflowRunId: "workflow-1", pipelineRunId: null, inputTokens: null, outputTokens: null, costUsd: null, occurredAt: 1_700_000_100_000 }),
      usage({ sourceId: "group-b", threadId: "thread-b", agentName: "review", provider: "claude", workflowName: "worklog", pipelineRunId: "run-1", inputTokens: 3, outputTokens: 4, costUsd: 0.25, occurredAt: 1_700_000_200_000 }),
      usage({ sourceId: "outside", threadId: "outside", inputTokens: 99, occurredAt: 1_700_001_000_000 }),
    ];
    const memory = new InMemoryUsageStore();
    for (const event of events) {
      await store.add(event);
      await memory.add(event);
    }
    for (const groupBy of ["session", "agent", "provider", "workflow", "pipeline"] as const) {
      await expect(store.groupBy({ from: 1_700_000_000_000, to: 1_700_000_300_000, groupBy }))
        .resolves.toEqual(await memory.groupBy({ from: 1_700_000_000_000, to: 1_700_000_300_000, groupBy }));
    }
  });

  it("aggregates a large event set without materializing usage rows", async () => {
    for (let i = 0; i < 2_000; i += 1) {
      await store.add(usage({
        sourceId: `large-${i}`,
        threadId: `thread-${i % 10}`,
        inputTokens: 1,
        outputTokens: 2,
        occurredAt: 1_700_000_000_000 + i,
      }));
    }
    const result = await store.groupBy({
      from: 1_700_000_000_000,
      to: 1_700_000_010_000,
      groupBy: "session",
    });
    expect(result.totals).toMatchObject({ turns: 2_000, inputTokens: 2_000, outputTokens: 4_000 });
    expect(result.buckets).toHaveLength(10);
  });

  it("deletes rows older than the retention cutoff", async () => {
    const now = 1_800_000_000_000;
    await store.add(usage({
      sourceId: "old",
      occurredAt: now - USAGE_RETENTION_MS - 1,
    }));
    await store.add(usage({
      sourceId: "fresh",
      occurredAt: now - 1_000,
    }));

    expect(await store.deleteOlderThan(now - USAGE_RETENTION_MS)).toBe(1);
    expect(await store.get("session-turn", "old")).toBeUndefined();
    expect(await store.get("session-turn", "fresh")).toBeDefined();
  });

  it("counts matching rows without listing them", async () => {
    await store.add(usage({
      sourceId: "t1:a",
      threadId: "t1",
      occurredAt: 100,
    }));
    await store.add(usage({
      sourceId: "t1:b",
      threadId: "t1",
      occurredAt: 200,
    }));
    await store.add(usage({
      sourceId: "t2:a",
      threadId: "t2",
      occurredAt: 300,
    }));

    expect(await store.count()).toBe(3);
    expect(await store.count({ threadId: "t1" })).toBe(2);
    expect(await store.count({ from: 150, to: 250 })).toBe(1);
  });

  it("summarizes spend for requested threads only", async () => {
    await store.add(usage({
      sourceId: "t1:a",
      threadId: "t1",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.1,
    }));
    await store.add(usage({
      sourceId: "t1:b",
      threadId: "t1",
      inputTokens: 5,
      outputTokens: 1,
      costUsd: 0.05,
    }));
    await store.add(usage({
      sourceId: "t2:a",
      threadId: "t2",
      inputTokens: 99,
      outputTokens: 9,
    }));

    const buckets = await store.summarizeByThread(["t1", "missing"]);
    expect(buckets[0]).toMatchObject({
      key: "t1",
      label: "t1",
      turns: 2,
      inputTokens: 15,
      outputTokens: 3,
      costEstimatedUsd: 0,
    });
    expect(buckets[0]!.costUsd).toBeCloseTo(0.15);
    expect(buckets[1]).toEqual({
      key: "missing",
      label: "missing",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costEstimatedUsd: 0,
    });
  });
});
