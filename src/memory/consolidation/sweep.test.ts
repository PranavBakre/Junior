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

/** Record ids in the order they appear in a built prompt's evidence block. */
function recordIdsInPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/- id=(\S+) from=/g)].map((m) => m[1]);
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

  it("clubs several small threads into a single fuller batch", async () => {
    await seed({ id: "a1", threadId: "T-a", body: "thread a, msg 1" });
    await seed({ id: "a2", threadId: "T-a", body: "thread a, msg 2" });
    await seed({ id: "b1", threadId: "T-b", body: "thread b, msg 1" });

    const prompts: string[] = [];
    const invoke: ConsolidationInvoke = async (prompt) => {
      prompts.push(prompt);
      return EMPTY;
    };

    // maxBatchChars defaults far above these tiny bodies → everything fits one batch.
    const reports = await runConsolidationSweep({ store, profileStore, embedder, invoke });

    expect(reports).toHaveLength(1);
    expect([...reports[0].threadIds].sort()).toEqual(["T-a", "T-b"]);
    // One LLM call carrying both threads' evidence.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("thread=T-a");
    expect(prompts[0]).toContain("thread=T-b");
    expect(await store.listUnconsolidatedSourceRecords({})).toHaveLength(0);
  });

  it("bin-packs groups First-Fit-Decreasing and keeps each thread contiguous", async () => {
    // bodyCap 1000 → no truncation; group sizes are the raw body lengths.
    // A = 30 + 30 = 60, B = 60, C = 30. maxBatchChars = 100.
    // FFD (desc): A(60) -> bin1; B(60) -> bin1 would be 120 > 100 so bin2;
    //             C(30) -> bin1 (90 <= 100). => bin1 = {A, C}, bin2 = {B}.
    await seed({ id: "a1", threadId: "T-a", body: "a".repeat(30) });
    await seed({ id: "a2", threadId: "T-a", body: "A".repeat(30) });
    await seed({ id: "b1", threadId: "T-b", body: "b".repeat(60) });
    await seed({ id: "c1", threadId: "T-c", body: "c".repeat(30) });

    const prompts: string[] = [];
    const invoke: ConsolidationInvoke = async (prompt) => {
      prompts.push(prompt);
      return EMPTY;
    };

    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke,
      maxBatchChars: 100,
      bodyCap: 1000,
    });

    expect(reports).toHaveLength(2);
    expect(reports[0].threadIds).toEqual(["T-a", "T-c"]);
    expect(reports[1].threadIds).toEqual(["T-b"]);
    // Thread A's two records stay contiguous, then thread C's record.
    expect(recordIdsInPrompt(prompts[0])).toEqual(["a1", "a2", "c1"]);
    expect(recordIdsInPrompt(prompts[1])).toEqual(["b1"]);
  });

  it("splits an oversized thread into consecutive ≤budget sub-chunks (each its own batch)", async () => {
    // runner_output (a capped kind) so bodyCap applies; kinds includes it so the
    // default high-value filter doesn't drop it. Four records cap to 50 each =>
    // group size 200 > maxBatchChars 120. Greedy split: [r1,r2]=100, [r3,r4]=100.
    let ts = 1000;
    for (const id of ["r1", "r2", "r3", "r4"]) {
      await seed({ id, threadId: "T-big", kind: "runner_output", body: `${id}-`.padEnd(80, "z"), createdAt: (ts += 1000) });
    }

    const prompts: string[] = [];
    const invoke: ConsolidationInvoke = async (prompt) => {
      prompts.push(prompt);
      return EMPTY;
    };

    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke,
      maxBatchChars: 120,
      bodyCap: 50,
      kinds: ["runner_output"],
    });

    // ceil(200/120) = 2 batches, each <= budget, all the same thread, in order.
    expect(reports).toHaveLength(2);
    expect(reports[0].threadIds).toEqual(["T-big"]);
    expect(reports[1].threadIds).toEqual(["T-big"]);
    expect(recordIdsInPrompt(prompts[0])).toEqual(["r1", "r2"]);
    expect(recordIdsInPrompt(prompts[1])).toEqual(["r3", "r4"]);
    expect(await store.listUnconsolidatedSourceRecords({})).toHaveLength(0);
  });

  it("puts an unsplittable single over-budget record alone in its own chunk", async () => {
    // curated_fact is never capped; the middle record (300 chars) alone exceeds
    // maxBatchChars 120 and cannot be split further, so it gets its own batch.
    // Explicit increasing createdAt so source order is deterministic (the store
    // orders by created_at ASC, then id ASC).
    await seed({ id: "small1", threadId: "T-cf", kind: "curated_fact", body: "a".repeat(30), createdAt: 1000 });
    await seed({ id: "big", threadId: "T-cf", kind: "curated_fact", body: "b".repeat(300), createdAt: 2000 });
    await seed({ id: "small2", threadId: "T-cf", kind: "curated_fact", body: "c".repeat(30), createdAt: 3000 });

    const prompts: string[] = [];
    const invoke: ConsolidationInvoke = async (prompt) => {
      prompts.push(prompt);
      return EMPTY;
    };

    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke,
      maxBatchChars: 120,
      bodyCap: 50,
      kinds: ["curated_fact"],
    });

    expect(reports).toHaveLength(3);
    expect(reports.every((r) => r.threadIds[0] === "T-cf")).toBe(true);
    expect(recordIdsInPrompt(prompts[0])).toEqual(["small1"]);
    expect(recordIdsInPrompt(prompts[1])).toEqual(["big"]); // alone, unsplittable
    expect(recordIdsInPrompt(prompts[2])).toEqual(["small2"]);
  });

  it("sizes by body-capped chars, not raw — a huge runner_output thread still packs with others", async () => {
    // Raw bodies (1000 each) blow past maxBatchChars 250, but runner_output capped
    // at 100 each makes the H group only 200, so H(200) + S(40) = 240 <= 250: ONE batch.
    await seed({ id: "h1", threadId: "T-h", kind: "runner_output", body: "h".repeat(1000) });
    await seed({ id: "h2", threadId: "T-h", kind: "runner_output", body: "H".repeat(1000) });
    await seed({ id: "s1", threadId: "T-s", kind: "runner_output", body: "s".repeat(40) });

    const prompts: string[] = [];
    const invoke: ConsolidationInvoke = async (prompt) => {
      prompts.push(prompt);
      return EMPTY;
    };

    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke,
      maxBatchChars: 250,
      bodyCap: 100,
      kinds: ["runner_output"],
    });

    expect(reports).toHaveLength(1);
    expect([...reports[0].threadIds].sort()).toEqual(["T-h", "T-s"]);
    // The long runner_output bodies are truncated in the prompt at bodyCap.
    expect(prompts[0]).toContain("…[truncated]");
  });

  it("filters to the high-value kinds by default — runner_output/routing_decision are deferred, not marked", async () => {
    await seed({ id: "keep", threadId: "T-keep", kind: "slack_message", body: "high-value message" });
    await seed({ id: "noise1", threadId: "T-noise", kind: "runner_output", body: "transcript noise" });
    await seed({ id: "noise2", threadId: "T-noise", kind: "routing_decision", body: "routing telemetry" });

    const prompts: string[] = [];
    const invoke: ConsolidationInvoke = async (prompt) => {
      prompts.push(prompt);
      return EMPTY;
    };

    // No `kinds` arg → default high-value set (excludes runner_output/routing_decision).
    const reports = await runConsolidationSweep({ store, profileStore, embedder, invoke });

    expect(reports).toHaveLength(1);
    expect(reports[0].threadIds).toEqual(["T-keep"]);
    expect(prompts[0]).not.toContain("transcript noise");
    expect(prompts[0]).not.toContain("routing telemetry");
    // Excluded kinds are deferred (left unconsolidated), only the kept record is stamped.
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-noise" })).toHaveLength(2);
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-keep" })).toHaveLength(0);
  });

  it("captures a failed batch and continues; that batch's records stay unconsolidated", async () => {
    await seed({ id: "ok1", threadId: "T-ok", body: "o".repeat(60) });
    await seed({ id: "bad1", threadId: "T-bad", body: `explodes ${"q".repeat(55)}` });

    const invoke: ConsolidationInvoke = async (prompt) => {
      if (prompt.includes("explodes")) throw new Error("malformed LLM JSON");
      return claimOutput("A durable lesson from the good thread.");
    };

    // Small budget forces each thread into its own batch, isolating the failure.
    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke,
      maxBatchChars: 80,
      bodyCap: 1000,
    });

    const bad = reports.find((r) => r.threadIds.includes("T-bad"));
    const ok = reports.find((r) => r.threadIds.includes("T-ok"));
    expect(bad?.error).toContain("malformed LLM JSON");
    expect(bad?.report).toBeUndefined();
    expect(ok?.report).toMatchObject({ skipped: false, claimsWritten: 1 });

    // The failed batch's records stay unconsolidated and retry next run.
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-bad" })).toHaveLength(1);
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-ok" })).toHaveLength(0);
  });

  it("consolidates unthreaded records alongside threaded ones (no separate sweep needed)", async () => {
    await seed({ id: "t1", threadId: "T-x", body: "threaded record" });
    await seed({ id: "u1", threadId: null, body: "unthreaded record" });

    const reports = await runConsolidationSweep({
      store,
      profileStore,
      embedder,
      invoke: async () => EMPTY,
    });

    expect(reports).toHaveLength(1);
    expect([...reports[0].threadIds].sort()).toEqual(["(unthreaded)", "T-x"]);
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
    expect(reports[0].threadIds).toEqual(["T-only"]);
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

  it("is a no-op on a second run once everything is consolidated (no invoke calls)", async () => {
    await seed({ id: "r1", threadId: "T-a", body: "first run derives this" });

    let calls = 0;
    const invoke: ConsolidationInvoke = async () => {
      calls += 1;
      return claimOutput("A durable lesson.");
    };

    const first = await runConsolidationSweep({ store, profileStore, embedder, invoke });
    expect(first[0].report).toMatchObject({ skipped: false, recordsProcessed: 1 });
    expect(calls).toBe(1);

    const second = await runConsolidationSweep({ store, profileStore, embedder, invoke });
    expect(second).toHaveLength(1);
    expect(second[0].report?.skipped).toBe(true);
    // Nothing pending → the engine is never invoked again.
    expect(calls).toBe(1);
  });
});

describe("summarizeConsolidationSweep", () => {
  it("reports the empty sweep", () => {
    expect(summarizeConsolidationSweep([])).toContain("no unconsolidated source records");
  });

  it("rolls up totals and surfaces failed scopes", () => {
    const text = summarizeConsolidationSweep([
      {
        threadIds: ["T-a"],
        report: { skipped: false, recordsProcessed: 3, episodes: 1, profiles: 1, claimsWritten: 2, claimsDeduped: 1 },
      },
      { threadIds: ["T-b"], error: "boom" },
      { threadIds: ["(unthreaded)"], report: { skipped: true } },
    ]);
    expect(text).toContain("T-a: 3 records");
    expect(text).toContain("T-b: FAILED — boom");
    expect(text).toContain("(unthreaded): skipped");
    expect(text).toContain("3 records processed, 1 episodes, 1 profiles, 2 claims written (1 deduped), 1 failed scope(s)");
  });
});
