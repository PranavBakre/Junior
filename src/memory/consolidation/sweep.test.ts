import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HashingEmbeddingProvider } from "../embedding/hashing.ts";
import { ProfileStore } from "../profiles/store.ts";
import { SqliteMemoryStore } from "../sqlite.ts";
import type { MemorySourceRecord } from "../types.ts";
import { runConsolidationSweep, summarizeConsolidationSweep } from "./sweep.ts";
import type { ConsolidationInvoke, ConsolidationOutput } from "./types.ts";

const EMPTY: ConsolidationOutput = { episodes: [], profiles: [], claims: [] };

function claimOutput(text: string): ConsolidationOutput {
  return { episodes: [], profiles: [], claims: [{ kind: "lesson", text }] };
}

describe("runConsolidationSweep", () => {
  let tmpDir: string;
  let store: SqliteMemoryStore;
  let profileStore: ProfileStore;
  let embedder: HashingEmbeddingProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-sweep-"));
    store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
    profileStore = new ProfileStore({ root: join(tmpDir, "profiles") });
    embedder = new HashingEmbeddingProvider(640);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seed(over: Partial<MemorySourceRecord> & { id: string }): Promise<void> {
    await store.appendSourceRecord({
      kind: "slack_message",
      threadId: "T1",
      actorId: "U_PRANAV",
      actorKind: "human",
      body: "some message body",
      createdAt: Date.now(),
      ...over,
    });
  }

  it("derives each thread on its own evidence — one entry per distinct thread, never mixed", async () => {
    await seed({ id: "a1", threadId: "T-a", body: "thread a, msg 1" });
    await seed({ id: "a2", threadId: "T-a", body: "thread a, msg 2" });
    await seed({ id: "b1", threadId: "T-b", body: "thread b, msg 1" });

    const seenThreadIds: Array<string | undefined> = [];
    const invoke: ConsolidationInvoke = async (prompt) => {
      // The prompt should only ever carry one thread's records per call.
      seenThreadIds.push(undefined);
      // Distinguish which thread by content presence (cheap, prompt is text).
      const aIn = prompt.includes("thread a");
      const bIn = prompt.includes("thread b");
      // Never both in the same call.
      expect(aIn && bIn).toBe(false);
      return EMPTY;
    };

    const reports = await runConsolidationSweep({ store, profileStore, embedder, invoke });

    const threadIds = reports.map((r) => r.threadId).sort();
    expect(threadIds).toEqual(["T-a", "T-b"]);
    // Two threads, two derivation calls — no unthreaded sweep needed.
    expect(seenThreadIds).toHaveLength(2);
    expect(reports.every((r) => r.report && !r.report.skipped)).toBe(true);
  });

  it("captures a thrown invoke instead of propagating, and keeps consolidating other threads", async () => {
    await seed({ id: "ok1", threadId: "T-ok", body: "good thread" });
    await seed({ id: "bad1", threadId: "T-bad", body: "explodes" });

    const invoke: ConsolidationInvoke = async (prompt) => {
      if (prompt.includes("explodes")) throw new Error("malformed LLM JSON");
      return claimOutput("A durable lesson from the good thread.");
    };

    const reports = await runConsolidationSweep({ store, profileStore, embedder, invoke });

    const bad = reports.find((r) => r.threadId === "T-bad");
    const ok = reports.find((r) => r.threadId === "T-ok");
    expect(bad?.error).toContain("malformed LLM JSON");
    expect(bad?.report).toBeUndefined();
    expect(ok?.report).toMatchObject({ skipped: false, claimsWritten: 1 });

    // The failed thread's records stay unconsolidated and retry next run.
    const remaining = await store.listUnconsolidatedSourceRecords({ threadId: "T-bad" });
    expect(remaining).toHaveLength(1);
    // The good thread was consumed.
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-ok" })).toHaveLength(0);
  });

  it("runs a final unthreaded sweep for records that carry no thread id", async () => {
    await seed({ id: "t1", threadId: "T-x", body: "threaded record" });
    await seed({ id: "u1", threadId: null, body: "unthreaded record" });

    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke: async () => EMPTY,
    });

    const scopes = reports.map((r) => r.threadId);
    // One threaded entry + one null (unthreaded) sweep entry.
    expect(scopes).toHaveLength(2);
    expect(scopes).toContain("T-x");
    expect(scopes).toContain(null);
    expect(await store.listUnconsolidatedSourceRecords({})).toHaveLength(0);
  });

  it("scopes to a single thread when threadId is set, honoring limit", async () => {
    await seed({ id: "s1", threadId: "T-only", body: "one" });
    await seed({ id: "s2", threadId: "T-only", body: "two" });
    await seed({ id: "other", threadId: "T-other", body: "other thread" });

    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke: async () => EMPTY,
      threadId: "T-only",
      limit: 1,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].threadId).toBe("T-only");
    // Only the limited single-thread pass ran — the other thread is untouched.
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-other" })).toHaveLength(1);
  });

  it("returns a single skipped entry when there is nothing to consolidate", async () => {
    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke: async () => EMPTY,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].report?.skipped).toBe(true);
  });
});

describe("summarizeConsolidationSweep", () => {
  it("reports the empty sweep", () => {
    expect(summarizeConsolidationSweep([])).toContain("no unconsolidated source records");
  });

  it("rolls up totals and surfaces failed scopes", () => {
    const text = summarizeConsolidationSweep([
      {
        threadId: "T-a",
        report: { skipped: false, recordsProcessed: 3, episodes: 1, profiles: 1, claimsWritten: 2, claimsDeduped: 1 },
      },
      { threadId: "T-b", error: "boom" },
      { threadId: null, report: { skipped: true } },
    ]);
    expect(text).toContain("T-a: 3 records");
    expect(text).toContain("T-b: FAILED — boom");
    expect(text).toContain("(all unthreaded): skipped");
    expect(text).toContain("3 records processed, 1 episodes, 1 profiles, 2 claims written (1 deduped), 1 failed scope(s)");
  });
});
