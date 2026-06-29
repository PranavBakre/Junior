import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "./sqlite.ts";

describe("SqliteMemoryStore", () => {
  let tmpDir: string;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-"));
    store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retrofits the memory_node.kind CHECK to allow 'claim' on a pre-v3 DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-memnode-retrofit-"));
    const dbPath = join(dir, "old.db");
    // Build a DB with the OLD memory_node CHECK (no 'claim'), as live DBs have.
    const raw = new Database(dbPath);
    raw.run(
      `CREATE TABLE memory_node (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory', 'entity', 'tag')), created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT)`,
    );
    raw.run("INSERT INTO memory_node (id, kind, created_at) VALUES ('n1', 'lesson', 1)");
    // Sanity: the old table rejects 'claim'.
    expect(() =>
      raw.run("INSERT INTO memory_node (id, kind, created_at) VALUES ('c0', 'claim', 1)"),
    ).toThrow();
    raw.close();

    // Opening the store runs migrate() → the retrofit rebuild.
    const s = new SqliteMemoryStore(dbPath);
    try {
      const db = (s as unknown as { db: Database }).db;
      const sql = (
        db.query("SELECT sql FROM sqlite_master WHERE name='memory_node'").get() as { sql: string }
      ).sql;
      expect(sql).toContain("'claim'");
      // Pre-existing rows survive the rebuild.
      expect(
        (db.query("SELECT kind FROM memory_node WHERE id='n1'").get() as { kind: string }).kind,
      ).toBe("lesson");
      // And a claim now upserts (writes a memory_node row with kind='claim').
      await s.upsertClaim({
        id: "c1",
        kind: "lesson",
        text: "claims now allowed",
        embedding: new Float32Array(640),
        embedModel: "hashing",
        dim: 640,
        tags: [],
        weight: 1,
        createdAt: 1,
        active: true,
      });
      expect(
        (db.query("SELECT kind FROM memory_node WHERE id='c1'").get() as { kind: string }).kind,
      ).toBe("claim");
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT create the condemned legacy tables (memory v3 cutover)", () => {
    const db = (store as unknown as { db: Database }).db;
    const exists = (name: string): boolean =>
      db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        )
        .get(name) != null;

    // The legacy associative-memory subsystem is retired; migrate() must never
    // recreate these (so DROP TABLE on a live DB sticks). memory_fts is an fts5
    // virtual table but also surfaces in sqlite_master with type 'table'.
    for (const name of [
      "memory_event",
      "edge",
      "mention",
      "memory_search_doc",
      "candidate_rule",
      "memory_fts",
    ]) {
      expect(exists(name)).toBe(false);
    }

    // Sanity: the kept v3 tables still exist.
    expect(exists("claim")).toBe(true);
    expect(exists("memory_source_record")).toBe(true);
    expect(exists("memory_node")).toBe(true);
  });

  it("creates the v3 claim and episode tables", () => {
    const db = (store as unknown as { db: Database }).db;
    const names = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    expect(names.has("claim")).toBe(true);
    expect(names.has("episode")).toBe(true);
  });

  it("upserts a claim and round-trips its Float32 embedding through the BLOB", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "claim-embed",
      kind: "lesson",
      text: "Prefer brute-force cosine before a vector database.",
      embedding: new Float32Array([0.25, -0.5, 0.75, 1]),
      embedModel: "harrier-270",
      repo: "junior",
      tags: ["memory", "vectors"],
      createdAt: now,
    });

    const db = (store as unknown as { db: Database }).db;
    const row = db
      .query<{ embedding: Uint8Array; dim: number; embed_model: string; tags: string }, [string]>(
        "SELECT embedding, dim, embed_model, tags FROM claim WHERE id = ?",
      )
      .get("claim-embed");
    expect(row?.dim).toBe(4);
    expect(row?.embed_model).toBe("harrier-270");
    expect(JSON.parse(row!.tags)).toEqual(["memory", "vectors"]);
    // Decode the little-endian BLOB back to floats.
    const buf = Buffer.from(row!.embedding);
    const decoded = Array.from({ length: buf.byteLength / 4 }, (_, i) => buf.readFloatLE(i * 4));
    expect(decoded[0]).toBeCloseTo(0.25, 5);
    expect(decoded[1]).toBeCloseTo(-0.5, 5);
    expect(decoded[2]).toBeCloseTo(0.75, 5);
    expect(decoded[3]).toBeCloseTo(1, 5);
  });

  it("ranks claims by cosine against a pre-computed query vector", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "claim-aligned",
      kind: "fact",
      text: "aligned claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-orthogonal",
      kind: "fact",
      text: "orthogonal claim",
      embedding: new Float32Array([0, 1, 0, 0]),
      createdAt: now,
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
    });

    expect(results.map((r) => r.id)).toEqual(["claim-aligned", "claim-orthogonal"]);
    expect(results[0].cosine).toBeCloseTo(1, 5);
    expect(results[1].cosine).toBeCloseTo(0, 5);
  });

  it("weights cosine by the claim weight", async () => {
    const now = Date.now();
    // Slightly lower cosine but much higher weight should win.
    await store.upsertClaim({
      id: "claim-light",
      kind: "fact",
      text: "light",
      embedding: new Float32Array([1, 0, 0, 0]),
      weight: 1,
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-heavy",
      kind: "fact",
      text: "heavy",
      embedding: new Float32Array([0.9, 0.1, 0, 0]),
      weight: 3,
      createdAt: now,
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
    });
    expect(results[0].id).toBe("claim-heavy");
  });

  it("applies WHERE filters BEFORE cosine, narrowing candidates", async () => {
    const now = Date.now();
    // repoA candidate is orthogonal (low cosine); repoB candidate is aligned.
    await store.upsertClaim({
      id: "claim-repoA",
      kind: "fact",
      text: "repo a claim",
      embedding: new Float32Array([0, 1, 0, 0]),
      repo: "gx-backend",
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-repoB",
      kind: "fact",
      text: "repo b claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      repo: "gx-client-next",
      createdAt: now,
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: { repo: "gx-backend" },
      limit: 5,
    });

    // Even though repoB is more aligned, the repo filter removes it from candidates.
    expect(results.map((r) => r.id)).toEqual(["claim-repoA"]);
  });

  it("filters claims by kind, tags, and sinceMs before ranking", async () => {
    const now = Date.now();
    await store.upsertClaim({ id: "c-old", kind: "fact", text: "old", repo: "r", tags: ["x"], createdAt: now - 10_000 });
    await store.upsertClaim({ id: "c-new-x", kind: "fact", text: "new x", repo: "r", tags: ["x"], createdAt: now });
    await store.upsertClaim({ id: "c-new-y", kind: "lesson", text: "new y", repo: "r", tags: ["y"], createdAt: now });

    const byKindTagRecency = await store.recallClaims({
      filters: { kind: "fact", tags: ["x"], sinceMs: now - 5_000 },
      limit: 5,
    });
    expect(byKindTagRecency.map((r) => r.id)).toEqual(["c-new-x"]);
  });

  it("appends an episode plus its backing source record", async () => {
    const now = Date.now();
    await store.appendEpisode({
      id: "ep_20260628_a1",
      actor: "pranav:person",
      subjects: ["pranav:person", "junior:self"],
      what: "Pranav called me an idiot for bypassing the merge rules.",
      emotion: "frustration",
      intensity: 0.7,
      valence: -0.6,
      trigger: "auto-merged to main, skipping dev-first",
      response: "apologized, fixed flow",
      salience: 0.85,
      threadId: "T-merge",
      actorKind: "human",
      createdAt: now,
    });

    const db = (store as unknown as { db: Database }).db;
    const episode = db
      .query<{ actor: string; subjects_json: string; emotion: string; salience: number; what: string }, [string]>(
        "SELECT actor, subjects_json, emotion, salience, what FROM episode WHERE id = ?",
      )
      .get("ep_20260628_a1");
    const source = db
      .query<{ body: string; thread_id: string; kind: string }, [string]>(
        "SELECT body, thread_id, kind FROM memory_source_record WHERE id = ?",
      )
      .get("ep_20260628_a1");

    expect(episode?.actor).toBe("pranav:person");
    expect(JSON.parse(episode!.subjects_json)).toEqual(["pranav:person", "junior:self"]);
    expect(episode?.emotion).toBe("frustration");
    expect(episode?.salience).toBeCloseTo(0.85, 5);
    expect(source?.body).toContain("called me an idiot");
    expect(source?.thread_id).toBe("T-merge");
    expect(source?.kind).toBe("slack_message");
  });

  // --- memory v3: last-used & decay (§7.1) ---------------------------------

  const lastUsedOf = (id: string): number | null => {
    const db = (store as unknown as { db: Database }).db;
    return (
      db
        .query<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM claim WHERE id = ?",
        )
        .get(id)?.last_used_at ?? null
    );
  };

  it("bumps claim.last_used_at on a genuine recall (recordUsage defaults true)", async () => {
    const created = Date.now() - 100_000;
    await store.upsertClaim({
      id: "claim-used",
      kind: "fact",
      text: "used claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      createdAt: created,
    });
    expect(lastUsedOf("claim-used")).toBeNull();

    const before = Date.now();
    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
    });
    expect(results.map((r) => r.id)).toEqual(["claim-used"]);
    // The returned row carries the PRE-bump value (null on first recall).
    expect(results[0].lastUsedAt).toBeNull();
    // The DB now records the recall.
    const bumped = lastUsedOf("claim-used");
    expect(bumped).not.toBeNull();
    expect(bumped!).toBeGreaterThanOrEqual(before);
  });

  it("does NOT bump claim.last_used_at when recordUsage is false (eval/dashboard reads)", async () => {
    await store.upsertClaim({
      id: "claim-inspected",
      kind: "fact",
      text: "inspected claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      createdAt: Date.now(),
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
      recordUsage: false,
    });
    expect(results.map((r) => r.id)).toEqual(["claim-inspected"]);
    // Inspection traffic must not pollute the fade signal.
    expect(lastUsedOf("claim-inspected")).toBeNull();
  });

  it("markEpisodesUsed bumps episode.last_used_at", async () => {
    const created = Date.now() - 50_000;
    await store.appendEpisode({ id: "ep-x", what: "x happened", createdAt: created });
    await store.appendEpisode({ id: "ep-y", what: "y happened", createdAt: created });

    const db = (store as unknown as { db: Database }).db;
    const read = (id: string) =>
      db
        .query<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM episode WHERE id = ?",
        )
        .get(id)?.last_used_at ?? null;
    expect(read("ep-x")).toBeNull();

    await store.markEpisodesUsed(["ep-x"], 1_700_000_000_000);
    expect(read("ep-x")).toBe(1_700_000_000_000);
    // Untouched episode stays null.
    expect(read("ep-y")).toBeNull();
  });

  it("archiveStaleClaims archives only stale-AND-low-weight claims, keeping the row", async () => {
    const now = 10_000_000_000_000;
    const old = now - 200 * 24 * 60 * 60 * 1000; // well past the cutoff
    const fresh = now - 1000;
    // stale + low weight  -> archive
    await store.upsertClaim({ id: "c-stale-low", kind: "fact", text: "a", weight: 0.2, lastUsedAt: old, createdAt: old });
    // stale + high weight  -> keep (value survives age)
    await store.upsertClaim({ id: "c-stale-high", kind: "fact", text: "b", weight: 5, lastUsedAt: old, createdAt: old });
    // fresh + low weight   -> keep (not stale)
    await store.upsertClaim({ id: "c-fresh-low", kind: "fact", text: "c", weight: 0.2, lastUsedAt: fresh, createdAt: old });
    // never used + old created_at + low weight -> archive
    await store.upsertClaim({ id: "c-neverused-low", kind: "fact", text: "d", weight: 0.2, createdAt: old });

    const result = await store.archiveStaleClaims({
      olderThanMs: 90 * 24 * 60 * 60 * 1000,
      maxWeight: 0.5,
      now,
    });
    expect(result.archivedIds.sort()).toEqual(["c-neverused-low", "c-stale-low"]);

    const db = (store as unknown as { db: Database }).db;
    const activeOf = (id: string) =>
      db.query<{ active: number }, [string]>("SELECT active FROM claim WHERE id = ?").get(id)?.active;
    // ARCHIVED, not deleted — rows are still present with active = 0.
    expect(activeOf("c-stale-low")).toBe(0);
    expect(activeOf("c-neverused-low")).toBe(0);
    // survivors stay active.
    expect(activeOf("c-stale-high")).toBe(1);
    expect(activeOf("c-fresh-low")).toBe(1);
  });

  it("memoryHealth reports corpus stats and fade candidates per kind", async () => {
    const now = 10_000_000_000_000;
    const old = now - 200 * 24 * 60 * 60 * 1000;
    await store.upsertClaim({ id: "h-used", kind: "lesson", text: "used", weight: 1, lastUsedAt: old, createdAt: old });
    await store.upsertClaim({ id: "h-never", kind: "lesson", text: "never", weight: 0.1, createdAt: old });
    await store.upsertClaim({ id: "h-fact", kind: "fact", text: "fact", weight: 1, lastUsedAt: now, createdAt: now });
    await store.appendEpisode({ id: "h-ep", what: "ep", createdAt: old });

    const health = await store.memoryHealth({ now, olderThanMs: 90 * 24 * 60 * 60 * 1000, maxWeight: 0.5 });
    expect(health.generatedAt).toBe(now);
    const byKind = Object.fromEntries(health.kinds.map((k) => [k.kind, k]));

    expect(byKind.lesson.total).toBe(2);
    expect(byKind.lesson.neverUsed).toBe(1);
    expect(byKind.lesson.pctNeverUsed).toBeCloseTo(0.5, 5);
    expect(byKind.lesson.oldestLastUsedAt).toBe(old);
    // only h-never is both stale (never used, old created_at) AND low-weight.
    expect(byKind.lesson.fadeCandidates).toBe(1);

    expect(byKind.fact.total).toBe(1);
    expect(byKind.fact.neverUsed).toBe(0);
    expect(byKind.fact.fadeCandidates).toBe(0);

    expect(byKind.episode.total).toBe(1);
    expect(byKind.episode.neverUsed).toBe(1);
    expect(byKind.episode.fadeCandidates).toBe(0);
  });
});
