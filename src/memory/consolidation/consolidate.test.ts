import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HashingEmbeddingProvider } from "../embedding/hashing.ts";
import { ProfileStore } from "../profiles/store.ts";
import { SqliteMemoryStore } from "../sqlite.ts";
import type { MemorySourceRecord } from "../types.ts";
import { consolidateSession } from "./consolidate.ts";
import { buildConsolidationPrompt } from "./prompt.ts";
import type { ConsolidationInvoke, ConsolidationOutput } from "./types.ts";

const EMPTY: ConsolidationOutput = { episodes: [], profiles: [], claims: [] };

function mockInvoke(output: ConsolidationOutput): ConsolidationInvoke {
  return async () => output;
}

describe("consolidateSession", () => {
  let tmpDir: string;
  let store: SqliteMemoryStore;
  let profileStore: ProfileStore;
  let embedder: HashingEmbeddingProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-consolidation-"));
    store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
    profileStore = new ProfileStore({ root: join(tmpDir, "profiles") });
    embedder = new HashingEmbeddingProvider(640);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function db(): Database {
    return (store as unknown as { db: Database }).db;
  }

  function episodeCount(): number {
    return (
      db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM episode").get()?.n ?? 0
    );
  }

  function episodeIds(): string[] {
    return db()
      .query<{ id: string }, []>("SELECT id FROM episode ORDER BY id")
      .all()
      .map((r) => r.id);
  }

  function claimSourceEpisodes(): Array<string | null> {
    return db()
      .query<{ source_episode: string | null }, []>("SELECT source_episode FROM claim ORDER BY id")
      .all()
      .map((r) => r.source_episode);
  }

  async function seedRecord(over: Partial<MemorySourceRecord> & { id: string }): Promise<void> {
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

  it("skips when there are no unconsolidated source records", async () => {
    const report = await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke(EMPTY),
    });
    expect(report).toEqual({ skipped: true });
  });

  it("appends episodes, upserts a profile, and writes embedded claims", async () => {
    await seedRecord({ id: "src-1", body: "Pranav called me an idiot for auto-merging to main" });
    await seedRecord({ id: "src-2", body: "fixed the merge flow" });

    const output: ConsolidationOutput = {
      episodes: [
        {
          sourceRecordId: "src-1",
          actor: "pranav:person",
          subjects: ["pranav:person", "junior:self"],
          emotion: "frustration",
          intensity: 0.7,
          valence: -0.6,
          trigger: "auto-merged to main",
          response: "apologized, fixed flow",
          salience: 0.85,
        },
      ],
      profiles: [
        {
          kind: "person",
          entity_ref: "pranav:person",
          triggers: ["bypassing merge rules"],
          body: "Pranav is the principal; pushes back hard on merge-rule violations.",
        },
      ],
      claims: [
        { kind: "lesson", text: "Always go dev-first; never auto-merge straight to main." },
      ],
    };

    const report = await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke(output),
    });

    expect(report).toMatchObject({
      skipped: false,
      recordsProcessed: 2,
      episodes: 1,
      profiles: 1,
      claimsWritten: 1,
      claimsDeduped: 0,
    });

    expect(episodeCount()).toBe(1);

    const profile = await profileStore.fetchByEntityRef("pranav:person");
    expect(profile).not.toBeNull();
    expect((profile as { triggers?: string[] }).triggers).toEqual(["bypassing merge rules"]);

    const vectors = await store.exportClaimVectors();
    expect(vectors).toHaveLength(1);
    expect(vectors[0].vector.length).toBe(640);
    expect(vectors[0].text).toContain("dev-first");
  });

  it("shows existing profiles to the LLM even when no record names their entity_ref", async () => {
    await profileStore.upsertProfile({
      kind: "person",
      entity_ref: "pranav:person",
      body: "Pranav prefers direct, plain implementation writing.",
    });

    // Plain Slack evidence: no literal "pranav:person" anywhere.
    await seedRecord({ id: "src-ctx", body: "shipped the dashboard tweaks" });

    let seenPrompt = "";
    await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: async (prompt) => {
        seenPrompt = prompt;
        return EMPTY;
      },
    });

    expect(seenPrompt).toContain("pranav:person");
    expect(seenPrompt).toContain("direct, plain implementation writing");
  });

  it("resolves Slack ids to names and shows the identity map in the prompt", async () => {
    await seedRecord({
      id: "src-who",
      actorId: "U03PNSJ33S5",
      body: "ask <@U0BONESID99> to review this",
    });

    let seenPrompt = "";
    await consolidateSession({
      store,
      profileStore,
      embedder,
      resolvePeople: async (ids) => {
        expect(ids.sort()).toEqual(["U03PNSJ33S5", "U0BONESID99"]);
        return new Map([
          ["U03PNSJ33S5", "Pranav Bakre"],
          ["U0BONESID99", "Bones"],
        ]);
      },
      invoke: async (prompt) => {
        seenPrompt = prompt;
        return EMPTY;
      },
    });

    expect(seenPrompt).toContain("## Who is who (Slack id → person)");
    expect(seenPrompt).toContain("- U03PNSJ33S5 = Pranav Bakre");
    expect(seenPrompt).toContain("- U0BONESID99 = Bones");
    // The record's from= line is annotated with the resolved name.
    expect(seenPrompt).toContain("from=U03PNSJ33S5 (Pranav Bakre)");
  });

  it("survives a resolver failure by falling back to raw ids", async () => {
    await seedRecord({ id: "src-who-fail", body: "hello" });

    let seenPrompt = "";
    const report = await consolidateSession({
      store,
      profileStore,
      embedder,
      resolvePeople: async () => {
        throw new Error("slack down");
      },
      invoke: async (prompt) => {
        seenPrompt = prompt;
        return EMPTY;
      },
    });

    expect(report).toMatchObject({ skipped: false, recordsProcessed: 1 });
    expect(seenPrompt).toContain("(no resolved identities");
  });

  it("merges an updating profile in place rather than duplicating it", async () => {
    await seedRecord({ id: "src-a", body: "first session about Pranav" });
    await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke({
        episodes: [],
        profiles: [
          {
            kind: "person",
            entity_ref: "pranav:person",
            triggers: ["scope creep"],
            body: "Pranav, first impression.",
          },
        ],
        claims: [],
      }),
    });

    // A later session updates the same entity_ref.
    await seedRecord({ id: "src-b", body: "second session about Pranav" });
    await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke({
        episodes: [],
        profiles: [
          {
            kind: "person",
            entity_ref: "pranav:person",
            triggers: ["bypassing merge rules"],
            body: "Pranav, updated sketch.",
          },
        ],
        claims: [],
      }),
    });

    const people = await profileStore.list("person");
    expect(people).toHaveLength(1);
    expect(people[0].entity_ref).toBe("pranav:person");
    expect((people[0] as { triggers?: string[] }).triggers).toEqual(["bypassing merge rules"]);
    expect(people[0].body).toContain("updated sketch");
  });

  it("dedups near-identical claim drafts and claims near an existing stored claim", async () => {
    // Pre-seed an EXISTING active claim with an embedding.
    const existingText = "Run dev-first; never auto-merge straight to main.";
    const [existingVec] = await embedder.embed([existingText], "document");
    await store.upsertClaim({
      id: "claim-existing",
      kind: "lesson",
      text: existingText,
      embedding: existingVec,
      embedModel: embedder.model,
      dim: embedder.dim,
      createdAt: Date.now(),
    });

    await seedRecord({ id: "src-d", body: "session" });

    const output: ConsolidationOutput = {
      episodes: [],
      profiles: [],
      claims: [
        // 1. Near-identical to the EXISTING stored claim -> deduped.
        { kind: "lesson", text: "Run dev-first; never auto-merge straight to main." },
        // 2. A genuinely new claim -> written.
        { kind: "fact", text: "The gx-backend server listens on port 8000 locally." },
        // 3. Near-identical to #2 within the same batch -> deduped.
        { kind: "fact", text: "The gx-backend server listens on port 8000 locally." },
      ],
    };

    const report = await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke(output),
    });

    expect(report).toMatchObject({ skipped: false, claimsWritten: 1, claimsDeduped: 2 });

    // existing + the one survivor = 2 total active claims.
    const vectors = await store.exportClaimVectors();
    expect(vectors).toHaveLength(2);
  });

  it("marks source records consolidated so a second pass skips them", async () => {
    await seedRecord({ id: "src-once", body: "only processed once" });

    const first = await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke(EMPTY),
    });
    expect(first).toMatchObject({ skipped: false, recordsProcessed: 1 });

    const second = await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke(EMPTY),
    });
    expect(second).toEqual({ skipped: true });
  });

  it("consolidates a pre-fetched multi-thread record set, citing the right ids across threads", async () => {
    // Records span two threads; the engine is handed the batch directly (records arg),
    // so it must NOT call listUnconsolidatedSourceRecords and must persist/stamp the set.
    await seedRecord({ id: "ta-1", threadId: "T-a", body: "thread a moment" });
    await seedRecord({ id: "tb-1", threadId: "T-b", body: "thread b moment" });
    // A decoy record that is NOT in the batch must stay unconsolidated.
    await seedRecord({ id: "tc-1", threadId: "T-c", body: "not in this batch" });

    const batch = (await store.listUnconsolidatedSourceRecords({})).filter((r) => r.id !== "tc-1");
    expect(batch).toHaveLength(2);

    const output: ConsolidationOutput = {
      episodes: [
        { sourceRecordId: "ta-1", emotion: "praise", intensity: 0.6, valence: 0.7, salience: 0.7 },
        { sourceRecordId: "tb-1", emotion: "frustration", intensity: 0.5, valence: -0.4, salience: 0.6 },
      ],
      profiles: [
        { kind: "person", entity_ref: "pranav:person", body: "Cross-thread observation about Pranav." },
      ],
      claims: [
        { kind: "lesson", text: "A lesson derived from thread A." },
        { kind: "fact", text: "A fact derived from thread B." },
      ],
    };

    const report = await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke(output),
      records: batch,
    });

    expect(report).toMatchObject({
      skipped: false,
      recordsProcessed: 2,
      episodes: 2,
      profiles: 1,
      claimsWritten: 2,
      claimsDeduped: 0,
    });

    // Episodes cite the correct source-record ids from BOTH threads.
    expect(episodeIds()).toEqual(["ta-1", "tb-1"]);
    expect(await profileStore.fetchByEntityRef("pranav:person")).not.toBeNull();
    expect(await store.exportClaimVectors()).toHaveLength(2);

    // ALL batch records are stamped consolidated; the decoy is untouched.
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-a" })).toHaveLength(0);
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-b" })).toHaveLength(0);
    expect(await store.listUnconsolidatedSourceRecords({ threadId: "T-c" })).toHaveLength(1);
  });

  it("nulls claim sourceEpisode for a multi-thread batch (no cross-thread backlink)", async () => {
    // Two threads, each contributing an episode + a claim in one batch. Attributing
    // either claim to appendedEpisodeIds[0] would falsely link across threads.
    await seedRecord({ id: "ta-1", threadId: "T-a", body: "thread a moment" });
    await seedRecord({ id: "tb-1", threadId: "T-b", body: "thread b moment" });
    const batch = await store.listUnconsolidatedSourceRecords({});

    await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke({
        episodes: [
          { sourceRecordId: "ta-1", emotion: "praise", salience: 0.7 },
          { sourceRecordId: "tb-1", emotion: "frustration", salience: 0.6 },
        ],
        profiles: [],
        claims: [
          { kind: "lesson", text: "A lesson from thread A." },
          { kind: "fact", text: "A fact from thread B." },
        ],
      }),
      records: batch,
    });

    expect(episodeCount()).toBe(2);
    const sources = claimSourceEpisodes();
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s === null)).toBe(true);
  });

  it("keeps the claim→episode backlink for a single-thread batch", async () => {
    await seedRecord({ id: "solo-1", threadId: "T-solo", body: "a notable single-thread moment" });
    await seedRecord({ id: "solo-2", threadId: "T-solo", body: "more of the same thread" });
    const batch = await store.listUnconsolidatedSourceRecords({});

    await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke({
        episodes: [{ sourceRecordId: "solo-1", emotion: "resolve", salience: 0.7 }],
        profiles: [],
        claims: [{ kind: "lesson", text: "A lesson from the single thread." }],
      }),
      records: batch,
    });

    expect(claimSourceEpisodes()).toEqual(["solo-1"]);
  });

  it("persists nothing for the high-bar empty-output case (but still consumes the records)", async () => {
    await seedRecord({ id: "src-empty", body: "mundane chatter, nothing durable" });

    const report = await consolidateSession({
      store,
      profileStore,
      embedder,
      invoke: mockInvoke(EMPTY),
    });

    expect(report).toMatchObject({
      skipped: false,
      recordsProcessed: 1,
      episodes: 0,
      profiles: 0,
      claimsWritten: 0,
      claimsDeduped: 0,
    });

    expect(episodeCount()).toBe(0);
    expect(await store.exportClaimVectors()).toHaveLength(0);
    expect(await profileStore.list()).toHaveLength(0);

    // The record was still consumed exactly once.
    const remaining = await store.listUnconsolidatedSourceRecords();
    expect(remaining).toHaveLength(0);
  });
});

describe("buildConsolidationPrompt body cap", () => {
  function record(over: Partial<MemorySourceRecord> & { id: string; body: string }): MemorySourceRecord {
    return {
      kind: "runner_output",
      threadId: "T1",
      actorKind: "agent",
      createdAt: Date.now(),
      ...over,
    } as MemorySourceRecord;
  }

  it("truncates a record longer than bodyCap and leaves shorter records untouched", () => {
    const longBody = "L".repeat(500);
    const shortBody = "short and sweet";
    const records = [record({ id: "long-1", body: longBody }), record({ id: "short-1", body: shortBody })];

    const prompt = buildConsolidationPrompt(records, { profiles: [], claims: [] }, 100);

    // Long body is cut to bodyCap chars + marker; the full 500-char run is gone.
    expect(prompt).toContain(`${"L".repeat(100)}…[truncated]`);
    expect(prompt).not.toContain("L".repeat(101));
    // Short body survives verbatim, with no marker.
    expect(prompt).toContain(shortBody);
  });

  it("applies no cap when bodyCap is unset", () => {
    const longBody = "L".repeat(500);
    const prompt = buildConsolidationPrompt([record({ id: "long-1", body: longBody })], { profiles: [], claims: [] });
    expect(prompt).toContain(longBody);
    expect(prompt).not.toContain("…[truncated]");
  });

  it("caps only the low-value kinds — a long curated_fact goes in whole, a long runner_output is cut", () => {
    const factBody = "F".repeat(500);
    const runnerBody = "R".repeat(500);
    const prompt = buildConsolidationPrompt(
      [
        record({ id: "fact-1", kind: "curated_fact", body: factBody }),
        record({ id: "run-1", kind: "runner_output", body: runnerBody }),
      ],
      { profiles: [], claims: [] },
      100,
    );

    // High-value curated_fact is never truncated, even with a cap set.
    expect(prompt).toContain(factBody);
    // Low-value runner_output is cut to the cap.
    expect(prompt).toContain(`${"R".repeat(100)}…[truncated]`);
    expect(prompt).not.toContain("R".repeat(101));
  });
});
