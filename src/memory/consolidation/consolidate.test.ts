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
