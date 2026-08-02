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

  it("widens an existing claim kind CHECK without losing rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-claim-kind-retrofit-"));
    const dbPath = join(dir, "old.db");
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE claim (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('lesson', 'fact', 'situation-claim')),
      text TEXT NOT NULL, retrieval_text TEXT, embedding BLOB, embed_model TEXT,
      dim INTEGER, repo TEXT, tags TEXT, source_episode TEXT,
      helpful_count INTEGER DEFAULT 0, unhelpful_count INTEGER DEFAULT 0,
      weight REAL DEFAULT 1.0, created_at INTEGER, last_used_at INTEGER,
      active INTEGER DEFAULT 1
    )`);
    raw.run("INSERT INTO claim (id, kind, text, created_at) VALUES ('old', 'fact', 'kept', 1)");
    raw.close();

    const migrated = new SqliteMemoryStore(dbPath);
    try {
      const db = (migrated as unknown as { db: Database }).db;
      const sql = (db.query("SELECT sql FROM sqlite_master WHERE name='claim'").get() as { sql: string }).sql;
      expect(sql).toContain("'preference'");
      expect(sql).toContain("'decision'");
      expect((db.query("SELECT text FROM claim WHERE id='old'").get() as { text: string }).text).toBe("kept");
      await migrated.upsertClaim({
        id: "pref",
        kind: "preference",
        text: "Prefer concise answers.",
        embedding: new Float32Array([1, 0]),
        createdAt: 2,
      });
    } finally {
      migrated.close();
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

  it("preserves a curated retrieval projection and its vector on an idempotent re-save", async () => {
    await store.upsertClaim({
      id: "claim-curated",
      kind: "lesson",
      text: "Authoritative rule",
      retrievalText: "When should this rule apply? Authoritative rule",
      embedding: new Float32Array([1, 0]),
      embedModel: "curated-model",
      createdAt: 1,
    });
    await store.upsertClaim({
      id: "claim-curated",
      kind: "lesson",
      text: "Authoritative rule",
      // memory_add-style idempotent save: no retrievalText, and a plain-text
      // embedding that must not replace the curated projection's vector.
      embedding: new Float32Array([0, 1]),
      embedModel: "plain-model",
      createdAt: 1,
    });

    const db = (store as unknown as { db: Database }).db;
    const row = db
      .query<
        { retrieval_text: string; embedding: Uint8Array; embed_model: string },
        [string]
      >(
        "SELECT retrieval_text, embedding, embed_model FROM claim WHERE id = ?",
      )
      .get("claim-curated")!;
    expect(row.retrieval_text).toBe(
      "When should this rule apply? Authoritative rule",
    );
    expect(row.embed_model).toBe("curated-model");
    const embedding = Buffer.from(row.embedding);
    expect(embedding.readFloatLE(0)).toBeCloseTo(1, 5);
    expect(embedding.readFloatLE(4)).toBeCloseTo(0, 5);
  });

  it("allows an explicit vector refresh for an unchanged plain-text claim", async () => {
    await store.upsertClaim({
      id: "claim-refresh",
      kind: "lesson",
      text: "Plain authoritative rule",
      embedding: new Float32Array([1, 0]),
      embedModel: "old-model",
      createdAt: 1,
    });
    await store.upsertClaim({
      id: "claim-refresh",
      kind: "lesson",
      text: "Plain authoritative rule",
      embedding: new Float32Array([0, 1]),
      embedModel: "new-model",
      createdAt: 1,
    });

    const db = (store as unknown as { db: Database }).db;
    const row = db
      .query<
        { retrieval_text: string; embedding: Uint8Array; embed_model: string },
        [string]
      >(
        "SELECT retrieval_text, embedding, embed_model FROM claim WHERE id = ?",
      )
      .get("claim-refresh")!;
    expect(row.retrieval_text).toBe("Plain authoritative rule");
    expect(row.embed_model).toBe("new-model");
    const embedding = Buffer.from(row.embedding);
    expect(embedding.readFloatLE(0)).toBeCloseTo(0, 5);
    expect(embedding.readFloatLE(4)).toBeCloseTo(1, 5);
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

  it("ranks vector recall by cosine before historical weight", async () => {
    const now = Date.now();
    // A much higher weight must not beat stronger semantic relevance. These sit at
    // cosine 0.99 of each other, so they are deliberately seeded past the write
    // guard (skipDedup) — this test is about recall RANKING, not about dedup.
    await store.upsertClaim({
      id: "claim-light",
      kind: "fact",
      text: "light",
      embedding: new Float32Array([1, 0, 0, 0]),
      weight: 1,
      createdAt: now,
      skipDedup: true,
    });
    await store.upsertClaim({
      id: "claim-heavy",
      kind: "fact",
      text: "heavy",
      embedding: new Float32Array([0.9, 0.1, 0, 0]),
      weight: 3,
      createdAt: now,
      skipDedup: true,
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
    });
    expect(results[0].id).toBe("claim-light");
  });

  it("keeps the strongest semantic match in the shortlist despite a low weight", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "best-semantic-match",
      kind: "fact",
      text: "exactly aligned but low value",
      embedding: new Float32Array([1, 0, 0, 0]),
      weight: 0.1,
      createdAt: now,
      skipDedup: true,
    });
    for (let index = 0; index < 12; index += 1) {
      await store.upsertClaim({
        id: `weighted-distractor-${index}`,
        kind: "fact",
        text: `weighted distractor ${index}`,
        embedding: new Float32Array([0.8, 0.6, 0, 0]),
        weight: 1,
        createdAt: now,
        skipDedup: true,
      });
    }

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 5,
      recordUsage: false,
    });

    expect(results.map((result) => result.id)).toContain("best-semantic-match");
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

  it("repoIncludeGlobal keeps repo-less claims but still excludes other repos", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "claim-mine",
      kind: "fact",
      text: "my repo claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      repo: "gx-backend",
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-global",
      kind: "lesson",
      text: "global lesson",
      embedding: new Float32Array([0.9, 0.1, 0, 0]),
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-other",
      kind: "fact",
      text: "other repo claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      repo: "gx-client-next",
      createdAt: now,
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: { repo: "gx-backend", repoIncludeGlobal: true },
      limit: 5,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("claim-mine");
    expect(ids).toContain("claim-global");
    expect(ids).not.toContain("claim-other");
  });

  it("filters claims by kind, tags, and sinceMs before ranking", async () => {
    const now = Date.now();
    // Vector-less fixtures: this test exercises the SQL WHERE pre-filter, which
    // runs before (and without) any cosine. skipDedup is what lets a row with no
    // embedding exist at all — see the write-guard contract on upsertClaim.
    await store.upsertClaim({ id: "c-old", kind: "fact", text: "old", repo: "r", tags: ["x"], createdAt: now - 10_000, skipDedup: true });
    await store.upsertClaim({ id: "c-new-x", kind: "fact", text: "new x", repo: "r", tags: ["x"], createdAt: now, skipDedup: true });
    await store.upsertClaim({ id: "c-new-y", kind: "lesson", text: "new y", repo: "r", tags: ["y"], createdAt: now, skipDedup: true });

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
    // Decay is a pure age/weight rule — vectors are irrelevant, so these rows
    // are seeded verbatim (skipDedup) rather than embedded.
    // stale + low weight  -> archive
    await store.upsertClaim({ id: "c-stale-low", kind: "fact", text: "a", weight: 0.2, lastUsedAt: old, createdAt: old, skipDedup: true });
    // stale + high weight  -> keep (value survives age)
    await store.upsertClaim({ id: "c-stale-high", kind: "fact", text: "b", weight: 5, lastUsedAt: old, createdAt: old, skipDedup: true });
    // fresh + low weight   -> keep (not stale)
    await store.upsertClaim({ id: "c-fresh-low", kind: "fact", text: "c", weight: 0.2, lastUsedAt: fresh, createdAt: old, skipDedup: true });
    // never used + old created_at + low weight -> archive
    await store.upsertClaim({ id: "c-neverused-low", kind: "fact", text: "d", weight: 0.2, createdAt: old, skipDedup: true });

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
    await store.upsertClaim({ id: "h-used", kind: "lesson", text: "used", weight: 1, lastUsedAt: old, createdAt: old, skipDedup: true });
    await store.upsertClaim({ id: "h-never", kind: "lesson", text: "never", weight: 0.1, createdAt: old, skipDedup: true });
    await store.upsertClaim({ id: "h-fact", kind: "fact", text: "fact", weight: 1, lastUsedAt: now, createdAt: now, skipDedup: true });
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

  // --- claim dedup write guard (docs/features/claim-dedup-write-guard.md) ----

  describe("claim write guard", () => {
    // Two vectors 0.9986 cosine apart (over the gate) and one orthogonal to both.
    const NEAR_A = new Float32Array([1, 0, 0, 0]);
    const NEAR_B = new Float32Array([0.95, 0.05, 0, 0]);
    const FAR = new Float32Array([0, 1, 0, 0]);
    const now = 1_700_000_000_000;

    type ValueRow = {
      helpful_count: number | null;
      unhelpful_count: number | null;
      weight: number | null;
      last_used_at: number | null;
      embedding: Uint8Array | null;
      active: number | null;
    };

    const rowOf = (id: string): ValueRow | null =>
      (store as unknown as { db: Database }).db
        .query<ValueRow, [string]>(
          "SELECT helpful_count, unhelpful_count, weight, last_used_at, embedding, active FROM claim WHERE id = ?",
        )
        .get(id) ?? null;

    // --- write-lock safety -------------------------------------------------

    it("opens the DB with a busy timeout so a second writer waits instead of failing", async () => {
      // `data/memory.db` has more than one writer (the in-process consolidation
      // sweep, plus any `bun run src/memory/cli.ts add-lesson` a workflow shells
      // out). At the SQLite default of 0 the loser of a race throws immediately.
      const timeout = (store as unknown as { db: Database }).db
        .query<{ timeout: number }, []>("PRAGMA busy_timeout")
        .get();
      expect(timeout?.timeout).toBeGreaterThan(0);
    });

    it("survives a concurrent commit landing inside the guard's read window", async () => {
      // The half a busy timeout CANNOT rescue. upsertClaim's transaction reads
      // (id lookup, then the whole corpus scan) before it writes; DEFERRED, that
      // takes a read snapshot, and a commit from another connection inside the
      // window kills the eventual write with SQLITE_BUSY_SNAPSHOT — an error
      // SQLite specifically does not let a busy handler retry.
      await store.upsertClaim({
        id: "x-anchor",
        kind: "lesson",
        text: "an existing claim to scan past",
        embedding: FAR,
        createdAt: now,
      });

      const db = (store as unknown as { db: Database }).db;
      const other = new Database(join(tmpDir, "memory.db"));
      other.run("PRAGMA journal_mode = WAL");
      other.run("PRAGMA busy_timeout = 50"); // keep the blocked case fast
      const realQuery = db.query.bind(db);
      // An object rather than a `let`: the writes happen inside the hook below,
      // where control-flow narrowing would otherwise pin the type at `null`.
      const interloper: { committed: boolean | null } = { committed: null };
      // Fire exactly once, on the neighbour scan — i.e. after the transaction's
      // first read has fixed its snapshot and before its first write.
      (db as unknown as { query: typeof db.query }).query = ((sql: string) => {
        // `id <> ?` is unique to findNearDuplicate's scan.
        if (interloper.committed === null && sql.includes("id <> ?")) {
          try {
            other.run("UPDATE claim SET last_used_at = 1 WHERE id = 'x-anchor'");
            interloper.committed = true;
          } catch {
            interloper.committed = false;
          }
        }
        return realQuery(sql);
      }) as typeof db.query;

      try {
        const result = await store.upsertClaim({
          id: "x-writer",
          kind: "lesson",
          text: "a genuinely new claim",
          embedding: NEAR_A,
          createdAt: now,
        });
        // The store's write WINS and the interloper is the one who backs off.
        // Deferred, this reverses: the interloper commits and this call throws.
        expect(result.action).toBe("inserted");
        expect(interloper.committed).toBe(false);
        expect(rowOf("x-writer")).not.toBeNull();
      } finally {
        (db as unknown as { query: typeof db.query }).query = realQuery;
        other.close();
      }
    });

    // --- the value-metadata data-loss bug --------------------------------

    it("defaults value columns on a fresh insert", async () => {
      await store.upsertClaim({
        id: "v-fresh",
        kind: "lesson",
        text: "fresh claim",
        embedding: NEAR_A,
        createdAt: now,
      });
      expect(rowOf("v-fresh")).toMatchObject({
        helpful_count: 0,
        unhelpful_count: 0,
        weight: 1,
      });
    });

    it("preserves accumulated weight and counters when a caller re-saves a claim by id", async () => {
      await store.upsertClaim({
        id: "v-keep",
        kind: "lesson",
        text: "accumulating claim",
        embedding: NEAR_A,
        createdAt: now,
        helpfulCount: 7,
        unhelpfulCount: 2,
        weight: 3.5,
        lastUsedAt: now - 5_000,
      });

      // Exactly what memory_add and `add-lesson` do: rewrite the same id without
      // restating the value fields. This used to reset weight to 1.0 and both
      // counters to 0, destroying the signal the merge path accumulates.
      const result = await store.upsertClaim({
        id: "v-keep",
        kind: "lesson",
        text: "accumulating claim",
        embedding: NEAR_A,
        createdAt: now,
      });

      expect(result).toMatchObject({ id: "v-keep", action: "updated" });
      expect(rowOf("v-keep")).toMatchObject({
        helpful_count: 7,
        unhelpful_count: 2,
        weight: 3.5,
        last_used_at: now - 5_000,
      });
    });

    it("distinguishes an explicit zero from an omitted value field", async () => {
      await store.upsertClaim({
        id: "v-zero",
        kind: "lesson",
        text: "explicitly reset",
        embedding: NEAR_A,
        createdAt: now,
        helpfulCount: 5,
        weight: 2,
      });
      await store.upsertClaim({
        id: "v-zero",
        kind: "lesson",
        text: "explicitly reset",
        embedding: NEAR_A,
        createdAt: now,
        helpfulCount: 0,
        weight: 0.25,
      });
      // A supplied 0 must WRITE 0 — COALESCE on a pre-defaulted binding would
      // silently treat it as "not supplied" and keep the old value.
      expect(rowOf("v-zero")).toMatchObject({ helpful_count: 0, weight: 0.25 });
    });

    it("preserves the stored embedding when a verbatim update omits it", async () => {
      await store.upsertClaim({
        id: "v-vec",
        kind: "lesson",
        text: "embedded claim",
        embedding: NEAR_A,
        createdAt: now,
      });
      await store.upsertClaim({
        id: "v-vec",
        kind: "lesson",
        text: "embedded claim, edited",
        createdAt: now,
        skipDedup: true,
      });
      // Erasing the vector would make the row unrecallable by cosine — the same
      // defect class as erasing the counters.
      expect(rowOf("v-vec")?.embedding).not.toBeNull();
    });

    // --- the guard itself -------------------------------------------------

    it("merges a near-duplicate into the survivor instead of storing a twin", async () => {
      await store.upsertClaim({
        id: "g-original",
        kind: "lesson",
        text: "`command <tool>` is the escape hatch when a wrapper alias is rewriting your invocation",
        embedding: NEAR_A,
        createdAt: now,
      });

      const result = await store.upsertClaim({
        id: "g-twin",
        kind: "lesson",
        text: "`command <tool>` is the escape hatch when a wrapper alias is silently rewriting your invocation",
        embedding: NEAR_B,
        createdAt: now,
      });

      expect(result).toEqual({ id: "g-original", action: "merged", mergedInto: "g-original" });
      // The twin row was never created.
      expect(rowOf("g-twin")).toBeNull();
      // Merge, don't drop: rediscovery makes the survivor harder to fade.
      const survivor = rowOf("g-original");
      expect(survivor?.helpful_count).toBe(1);
      expect(survivor?.weight).toBeCloseTo(1.1, 5);
      expect(survivor?.last_used_at).not.toBeNull();
    });

    it("converges on a weight ceiling when the same text merges over and over", async () => {
      await store.upsertClaim({
        id: "b-anchor",
        kind: "lesson",
        text: "the anchor",
        embedding: NEAR_A,
        createdAt: now,
      });

      // A merge writes NO row for the twin, so the same input merges again on
      // every call — a Stop hook re-asserting one lesson each session would add
      // +0.1 forever. recallClaims scores `cosine * weight`, so an unbounded
      // weight lets a low-cosine claim outrank everything, permanently: nothing
      // in the codebase decrements a weight, and archiveStaleClaims has no
      // caller. The ceiling is the only bound there is.
      for (let i = 0; i < 30; i += 1) {
        const result = await store.upsertClaim({
          id: `b-twin-${i}`,
          kind: "lesson",
          text: "the anchor, reworded",
          embedding: NEAR_B,
          createdAt: now,
        });
        expect(result.mergedInto).toBe("b-anchor");
      }

      // Converged, not growing: 1.0 + 30 * 0.1 would be 4.0 without the ceiling.
      expect(rowOf("b-anchor")?.weight).toBeCloseTo(2.0, 5);
      // The count itself is uncapped — it feeds no ranking and is the honest
      // record of how many times this was rediscovered.
      expect(rowOf("b-anchor")?.helpful_count).toBe(30);
    });

    it("never lowers a weight that is already above the merge ceiling", async () => {
      await store.upsertClaim({
        id: "b-heavy",
        kind: "lesson",
        text: "a deliberately heavy claim",
        embedding: NEAR_A,
        createdAt: now,
        weight: 9,
        skipDedup: true,
      });
      await store.upsertClaim({
        id: "b-heavy-twin",
        kind: "lesson",
        text: "a deliberately heavy claim, reworded",
        embedding: NEAR_B,
        createdAt: now,
      });
      // The cap holds a BUMP down; it must not pull an explicitly-set weight back.
      expect(rowOf("b-heavy")?.weight).toBe(9);
    });

    it("stores a genuinely distinct claim rather than merging it", async () => {
      await store.upsertClaim({
        id: "g-a",
        kind: "lesson",
        text: "claim a",
        embedding: NEAR_A,
        createdAt: now,
      });
      const result = await store.upsertClaim({
        id: "g-b",
        kind: "lesson",
        text: "claim b",
        embedding: FAR,
        createdAt: now,
      });
      expect(result).toEqual({ id: "g-b", action: "inserted" });
    });

    it("never merges across kinds", async () => {
      await store.upsertClaim({
        id: "k-lesson",
        kind: "lesson",
        text: "same text, different kind",
        embedding: NEAR_A,
        createdAt: now,
      });
      // Identical vector, different kind — cross-kind dedup is on the cut list.
      const result = await store.upsertClaim({
        id: "k-fact",
        kind: "fact",
        text: "same text, different kind",
        embedding: NEAR_A,
        createdAt: now,
      });
      expect(result.action).toBe("inserted");
    });

    it("never merges between a global claim and a repo-specific one, in either direction", async () => {
      await store.upsertClaim({
        id: "s-global",
        kind: "lesson",
        text: "global lesson",
        embedding: NEAR_A,
        createdAt: now,
      });
      // repo-specific into global would leak one repo's convention everywhere.
      const intoGlobal = await store.upsertClaim({
        id: "s-repo",
        kind: "lesson",
        text: "repo lesson",
        embedding: NEAR_B,
        repo: "gx-backend",
        createdAt: now,
      });
      expect(intoGlobal.action).toBe("inserted");

      // global into repo-specific would narrow knowledge that applies everywhere.
      const intoRepo = await store.upsertClaim({
        id: "s-global-2",
        kind: "lesson",
        text: "another global lesson",
        embedding: NEAR_B,
        createdAt: now,
      });
      expect(intoRepo.action).toBe("merged");
      expect(intoRepo.mergedInto).toBe("s-global");

      // ...but two claims in the SAME repo do merge.
      const sameRepo = await store.upsertClaim({
        id: "s-repo-2",
        kind: "lesson",
        text: "repo lesson reworded",
        embedding: NEAR_A,
        repo: "gx-backend",
        createdAt: now,
      });
      expect(sameRepo).toMatchObject({ action: "merged", mergedInto: "s-repo" });
    });

    it("picks the winner deterministically: highest weight, then oldest, then lowest id", async () => {
      // Each scenario gets its own repo so the three candidate sets never mix.
      const seed = (id: string, repo: string, weight: number, createdAt: number) =>
        store.upsertClaim({
          id,
          kind: "lesson",
          text: `seed ${id}`,
          embedding: NEAR_A,
          repo,
          weight,
          createdAt,
          skipDedup: true,
        });

      // 1. weight beats age and id.
      await seed("w-aaa", "r-weight", 1, now - 10_000);
      await seed("w-zzz", "r-weight", 9, now);
      // 2. equal weight -> oldest created_at.
      await seed("a-zzz", "r-age", 4, now - 10_000);
      await seed("a-aaa", "r-age", 4, now);
      // 3. equal weight and age -> lowest id.
      await seed("i-zzz", "r-id", 4, now);
      await seed("i-aaa", "r-id", 4, now);

      const write = (repo: string) =>
        store.upsertClaim({
          id: `probe-${repo}`,
          kind: "lesson",
          text: `probe ${repo}`,
          embedding: NEAR_B,
          repo,
          createdAt: now,
        });

      expect((await write("r-weight")).mergedInto).toBe("w-zzz");
      expect((await write("r-age")).mergedInto).toBe("a-zzz");
      expect((await write("r-id")).mergedInto).toBe("i-aaa");
    });

    it("re-scans an update whose text changed — a new claim wearing an old id", async () => {
      await store.upsertClaim({
        id: "u-anchor",
        kind: "lesson",
        text: "the anchor claim",
        embedding: NEAR_A,
        createdAt: now,
      });
      await store.upsertClaim({
        id: "u-drifting",
        kind: "lesson",
        text: "something unrelated",
        embedding: FAR,
        createdAt: now,
      });

      // Same id, materially different text that now lands on top of the anchor.
      const result = await store.upsertClaim({
        id: "u-drifting",
        kind: "lesson",
        text: "the anchor claim, reworded",
        embedding: NEAR_B,
        createdAt: now,
      });
      expect(result).toMatchObject({ action: "merged", mergedInto: "u-anchor" });
      // The updated row is FOLDED into the survivor and ARCHIVED. Its stored text
      // is no longer asserted by anyone — the caller just replaced it — so leaving
      // it active would keep serving text nobody stands behind, and no later write
      // could repair it: every subsequent edit of this id re-merges the same way.
      expect(rowOf("u-drifting")?.active).toBe(0);
      const text = (store as unknown as { db: Database }).db
        .query<{ text: string }, [string]>("SELECT text FROM claim WHERE id = ?")
        .get("u-drifting")?.text;
      // Archived, not rewritten: the row stays as provenance of what it said.
      expect(text).toBe("something unrelated");
    });

    it("stops the superseded text from competing in recall (the correct-a-lesson path)", async () => {
      // The live repro, through the shape `add-lesson --id <existing>` produces:
      // an id that already holds one claim is re-saved with text that belongs to
      // a DIFFERENT existing claim.
      await store.upsertClaim({
        id: "npm-rule",
        kind: "lesson",
        text: "All GrowthX repos use npm.",
        embedding: NEAR_A,
        createdAt: now,
      });
      await store.upsertClaim({
        id: "pkg-mgr",
        kind: "lesson",
        text: "Something completely different about docker.",
        embedding: FAR,
        createdAt: now,
        helpfulCount: 4,
        unhelpfulCount: 1,
      });

      // The correction.
      const result = await store.upsertClaim({
        id: "pkg-mgr",
        kind: "lesson",
        text: "All GrowthX repos use npm.",
        embedding: NEAR_B,
        createdAt: now,
      });
      expect(result).toEqual({ id: "npm-rule", action: "merged", mergedInto: "npm-rule" });

      // The docker sentence is out of the active corpus...
      const hits = await store.recallClaims({ queryVector: FAR, limit: 5, recordUsage: false });
      expect(hits.map((h) => h.id)).not.toContain("pkg-mgr");
      // ...and its accumulated counters moved to the survivor rather than being
      // stranded on an archived row (+1 for the rediscovery itself).
      expect(rowOf("npm-rule")).toMatchObject({ helpful_count: 5, unhelpful_count: 1 });
    });

    // --- bypass ------------------------------------------------------------

    it("rejects a claim with no embedding unless the write is an explicit restore", async () => {
      // The store never embeds (callers embed at the boundary), so a vector-less
      // claim is unguardable AND invisible to cosine recall.
      await expect(
        store.upsertClaim({ id: "e-none", kind: "lesson", text: "no vector", createdAt: now }),
      ).rejects.toThrow(/embedding/);

      const restored = await store.upsertClaim({
        id: "e-none",
        kind: "lesson",
        text: "no vector",
        createdAt: now,
        skipDedup: true,
      });
      expect(restored.action).toBe("inserted");
    });

    it("skipDedup writes a near-duplicate verbatim (migrate-v3 / restore path)", async () => {
      await store.upsertClaim({
        id: "b-first",
        kind: "lesson",
        text: "historical claim",
        embedding: NEAR_A,
        createdAt: now,
      });
      const result = await store.upsertClaim({
        id: "b-second",
        kind: "lesson",
        text: "historical claim, near-identical",
        embedding: NEAR_B,
        createdAt: now,
        skipDedup: true,
      });

      expect(result).toEqual({ id: "b-second", action: "inserted" });
      // Both rows exist and stay active — history goes in as it was.
      expect(rowOf("b-first")?.active).toBe(1);
      expect(rowOf("b-second")?.active).toBe(1);
      // ...and the survivor was NOT bumped, because no merge happened.
      expect(rowOf("b-first")?.helpful_count).toBe(0);
    });

    it("skipDedup keeps an archived historical row archived", async () => {
      const result = await store.upsertClaim({
        id: "b-archived",
        kind: "lesson",
        text: "archived history",
        embedding: NEAR_A,
        createdAt: now,
        active: false,
        skipDedup: true,
      });
      expect(result.action).toBe("inserted");
      expect(rowOf("b-archived")?.active).toBe(0);
    });

    // --- collapse (the sweep's write primitive) ---------------------------

    it("collapseDuplicateClaims folds counters into the survivor and archives, never deletes", async () => {
      const seed = (id: string, helpful: number, lastUsedAt: number | null) =>
        store.upsertClaim({
          id,
          kind: "lesson",
          text: `cluster member ${id}`,
          embedding: NEAR_A,
          createdAt: now,
          helpfulCount: helpful,
          lastUsedAt,
          skipDedup: true,
        });
      await seed("c-survivor", 3, now - 50_000);
      await seed("c-dup-1", 4, now - 10_000);
      await seed("c-dup-2", 5, null);

      const result = await store.collapseDuplicateClaims({
        survivorId: "c-survivor",
        duplicateIds: ["c-dup-1", "c-dup-2"],
      });
      expect(result.archivedIds.sort()).toEqual(["c-dup-1", "c-dup-2"]);

      const survivor = rowOf("c-survivor");
      expect(survivor?.helpful_count).toBe(12);
      // Inherits the cluster's NEWEST genuine use — a backfill must not invent
      // freshness by stamping "now" across the corpus.
      expect(survivor?.last_used_at).toBe(now - 10_000);
      // Archived, not deleted: the collapsed rows stay as provenance.
      expect(rowOf("c-dup-1")?.active).toBe(0);
      expect(rowOf("c-dup-2")?.active).toBe(0);
    });

    it("re-adding a swept claim re-checks the corpus instead of resurrecting it", async () => {
      await store.upsertClaim({
        id: "r-survivor",
        kind: "lesson",
        text: "the surviving claim",
        embedding: NEAR_A,
        createdAt: now,
      });
      await store.upsertClaim({
        id: "r-dup",
        kind: "lesson",
        text: "the surviving claim, reworded",
        embedding: NEAR_B,
        createdAt: now,
        skipDedup: true,
      });
      await store.collapseDuplicateClaims({
        survivorId: "r-survivor",
        duplicateIds: ["r-dup"],
      });

      // Re-adding the archived duplicate by its own id must not flip it back to
      // active — that would undo the sweep one write at a time.
      const result = await store.upsertClaim({
        id: "r-dup",
        kind: "lesson",
        text: "the surviving claim, reworded",
        embedding: NEAR_B,
        createdAt: now,
      });
      expect(result).toMatchObject({ action: "merged", mergedInto: "r-survivor" });
      expect(rowOf("r-dup")?.active).toBe(0);
    });

    it("re-adds of an ARCHIVED row never re-fold its counters into the survivor", async () => {
      await store.upsertClaim({
        id: "z-survivor",
        kind: "lesson",
        text: "the surviving claim",
        embedding: NEAR_A,
        createdAt: now,
      });
      await store.upsertClaim({
        id: "z-dup",
        kind: "lesson",
        text: "the surviving claim, reworded",
        embedding: NEAR_B,
        createdAt: now,
        helpfulCount: 6,
        skipDedup: true,
      });
      await store.collapseDuplicateClaims({ survivorId: "z-survivor", duplicateIds: ["z-dup"] });
      // The sweep already moved z-dup's 6 into the survivor.
      expect(rowOf("z-survivor")?.helpful_count).toBe(6);

      const readd = () =>
        store.upsertClaim({
          id: "z-dup",
          kind: "lesson",
          text: "the surviving claim, reworded",
          embedding: NEAR_B,
          createdAt: now,
        });
      await readd();
      await readd();

      // +1 per rediscovery and nothing more. Folding the archived row again on
      // each re-add would double-count counters the sweep already banked.
      expect(rowOf("z-survivor")?.helpful_count).toBe(8);
      expect(rowOf("z-dup")?.helpful_count).toBe(6);
      expect(rowOf("z-dup")?.active).toBe(0);
    });

    // --- standing metric ---------------------------------------------------

    it("memoryHealth reports the near-duplicate rate within a dedup scope", async () => {
      const seed = (id: string, embedding: Float32Array, repo: string | null) =>
        store.upsertClaim({
          id,
          kind: "lesson",
          text: `health ${id}`,
          embedding,
          repo,
          createdAt: now,
          skipDedup: true,
        });
      await seed("h-twin-a", NEAR_A, null);
      await seed("h-twin-b", NEAR_B, null);
      await seed("h-lonely", FAR, null);
      // Same vector as the twins but a DIFFERENT scope — not a near-duplicate,
      // because the sweep would never merge it.
      await seed("h-other-repo", NEAR_A, "gx-backend");
      // A vector-less legacy row. It counts toward `total` but no cosine can
      // ever match it, so including it in the RATE's denominator would just
      // understate the rate (4/5 vs 4/4 of the corpus that can be measured).
      await store.upsertClaim({
        id: "h-no-vector",
        kind: "lesson",
        text: "a legacy claim with no embedding",
        createdAt: now,
        skipDedup: true,
      });

      const health = await store.memoryHealth({ now });
      const lesson = health.kinds.find((k) => k.kind === "lesson");
      expect(health.dedupThreshold).toBe(0.92);
      expect(lesson?.total).toBe(5);
      expect(lesson?.nearDuplicates).toBe(2);
      // 2 twins over the 4 EMBEDDED lessons. Over `total` this would be 0.4.
      expect(lesson?.nearDuplicateRate).toBeCloseTo(0.5, 5);

      const skipped = await store.memoryHealth({ now, includeNearDuplicates: false });
      expect(skipped.kinds.find((k) => k.kind === "lesson")?.nearDuplicates).toBeNull();
    });
  });
});
