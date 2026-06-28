/**
 * Tests for the v3 migration (lesson + memory_fact → claim, drop condemned).
 *
 * NOTE: these use the HASHING embedding provider for determinism and speed. The
 * hashing provider is lexical (no synonymy), so it validates the migration
 * MECHANICS only — row counts, the merge/union/max-weight bookkeeping, the
 * apply gate, and the table drops. Real *semantic* dedup quality (collapsing
 * paraphrases that don't share tokens) needs the local (harrier) provider at
 * cutover; that is out of scope for a fast unit test. Seed texts here use
 * vocabulary-disjoint token sets across groups so hashing cosine is ~0 between
 * groups and high within the near-duplicate pair, making clustering exact.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "./factory.ts";
import { createEmbeddingProvider } from "./embedding/factory.ts";
import { migrateV3, type MigrateV3Report } from "./migrate-v3.ts";

const CONDEMNED = [
  "memory_event",
  "edge",
  "mention",
  "memory_search_doc",
  "candidate_rule",
];

interface ClaimRow {
  id: string;
  kind: string;
  text: string;
  tags: string | null;
  weight: number;
}

/**
 * Seed a fresh DB at dbPath with 3 lessons (two of them a near-duplicate pair)
 * and 2 facts (one with a null title), plus tags via memory_tag ⋈ tag.
 */
function seed(dbPath: string): void {
  // createMemoryStore runs the schema migration (lesson/memory_fact/tag/claim/…).
  const store = createMemoryStore(dbPath);
  store.close();

  const db = new Database(dbPath);
  const now = Date.now();

  const insLesson = db.query(
    `INSERT INTO lesson (id, title, body, applies_when, importance, created_at, last_used_at, use_count, active)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, 0, 1)`,
  );
  const insFact = db.query(
    `INSERT INTO memory_fact (id, kind, title, body, confidence, importance, created_at, last_used_at, use_count, active)
     VALUES (?, ?, ?, ?, 0.5, ?, ?, NULL, 0, 1)`,
  );
  const insTag = db.query(`INSERT INTO tag (id, name) VALUES (?, ?)`);
  const insMemTag = db.query(
    `INSERT INTO memory_tag (memory_id, tag_id, memory_kind) VALUES (?, ?, ?)`,
  );

  // L1 / L2 — near-duplicate pair (6 shared tokens, L2 adds one). L1 has the
  // higher importance so it must win as the survivor.
  insLesson.run("L1", "always use worktree", "never commit main directly always branch", 0.9, now);
  insLesson.run("L2", "always use worktree", "never commit main directly always branch first", 0.5, now);
  // L3 — vocabulary-disjoint lesson; must NOT merge.
  insLesson.run("L3", "sync before reading", "fetch logs upstream conclusions verify", 0.8, now);

  // F1 — fact with a title; F2 — fact with a null title.
  insFact.run("F1", "curated_fact", "repository paths", "projects directory holds repositories", 0.7, now);
  insFact.run("F2", "routing_memory", null, "pranav prefers terse responses please", 0.6, now);

  insTag.run("tag_workflow", "workflow");
  insTag.run("tag_git", "git");
  insTag.run("tag_sync", "sync");
  insTag.run("tag_repo", "repo");

  insMemTag.run("L1", "tag_workflow", "lesson");
  insMemTag.run("L2", "tag_git", "lesson");
  insMemTag.run("L3", "tag_sync", "lesson");
  insMemTag.run("F1", "tag_repo", "fact");

  db.close();
}

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) != null
  );
}

describe("migrateV3", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "migrate-v3-"));
    dbPath = join(tmpDir, "memory.db");
    seed(dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("apply=true: lessons + facts become claims, near-dup pair merges (union tags, max weight)", async () => {
    const provider = createEmbeddingProvider("hashing");
    const report = await migrateV3({
      dbPath,
      provider,
      apply: true,
      dedupeThreshold: 0.5, // low threshold — the near-dup pair must collapse
    });

    // Report counts.
    const expected: MigrateV3Report = {
      lessons: 3,
      facts: 2,
      skippedTelemetry: 0,
      embedded: 5,
      claimsWritten: 4, // L1+L2 merge → 1, plus L3, F1, F2
      duplicatesMerged: 1,
      tablesDropped: report.tablesDropped, // checked below
      applied: true,
    };
    expect(report).toEqual(expected);

    const db = new Database(dbPath);
    try {
      const claims = db
        .query("SELECT id, kind, text, tags, weight FROM claim ORDER BY id")
        .all() as ClaimRow[];

      // 5 source rows → 4 surviving claims.
      expect(claims.length).toBe(4);

      const byId = new Map(claims.map((c) => [c.id, c]));
      // Survivor is L1 (higher weight), not L2.
      expect(byId.has("L1")).toBe(true);
      expect(byId.has("L2")).toBe(false);
      expect(byId.has("L3")).toBe(true);
      expect(byId.has("F1")).toBe(true);
      expect(byId.has("F2")).toBe(true);

      const merged = byId.get("L1")!;
      expect(merged.kind).toBe("lesson");
      expect(merged.weight).toBe(0.9); // max(0.9, 0.5)
      const mergedTags = JSON.parse(merged.tags ?? "[]") as string[];
      expect(mergedTags).toContain("workflow"); // from L1
      expect(mergedTags).toContain("git"); // unioned from L2

      // Kinds carried correctly.
      expect(byId.get("F1")!.kind).toBe("fact");
      expect(byId.get("F2")!.kind).toBe("fact");
      // Fact with null title → text is just the body.
      expect(byId.get("F2")!.text).toBe("pranav prefers terse responses please");
      // Lesson text is title + "\n" + body.
      expect(byId.get("L3")!.text).toBe("sync before reading\nfetch logs upstream conclusions verify");
    } finally {
      db.close();
    }
  });

  it("excludes routing-decision telemetry from the claim corpus", async () => {
    // Inject the two telemetry shapes that leaked into the legacy tables.
    const db = new Database(dbPath);
    const now = Date.now();
    db.query(
      `INSERT INTO memory_fact (id, kind, title, body, confidence, importance, created_at, last_used_at, use_count, active)
       VALUES (?, ?, ?, ?, 0.5, ?, ?, NULL, 0, 1)`,
    ).run("T1", "routing_memory", "Routing decision: default", "Selected default via single-session.", 1.0, now);
    db.query(
      `INSERT INTO memory_fact (id, kind, title, body, confidence, importance, created_at, last_used_at, use_count, active)
       VALUES (?, ?, NULL, ?, 0.5, ?, ?, NULL, 0, 1)`,
    ).run("T2", "routing_memory", "Selected review via persistent-agent.", 1.0, now);
    db.close();

    const report = await migrateV3({
      dbPath,
      provider: createEmbeddingProvider("hashing"),
      apply: true,
      dedupeThreshold: 0.99,
    });

    expect(report.skippedTelemetry).toBe(2);
    expect(report.facts).toBe(2); // F1, F2 — telemetry T1/T2 excluded
    expect(report.embedded).toBe(5); // 3 lessons + 2 real facts, no telemetry

    const verify = new Database(dbPath);
    try {
      const claims = verify.query("SELECT id, text FROM claim").all() as { id: string; text: string }[];
      expect(claims.find((c) => c.id === "T1" || c.id === "T2")).toBeUndefined();
      expect(claims.some((c) => /Routing decision:|Selected .* via/.test(c.text))).toBe(false);
    } finally {
      verify.close();
    }
  });

  it("apply=true: drops every condemned table", async () => {
    const provider = createEmbeddingProvider("hashing");
    const report = await migrateV3({ dbPath, provider, apply: true, dedupeThreshold: 0.5 });

    expect(report.tablesDropped.sort()).toEqual([...CONDEMNED].sort());

    const db = new Database(dbPath);
    try {
      for (const t of CONDEMNED) {
        expect(tableExists(db, t)).toBe(false);
      }
      // The claim table (the keep target) survives.
      expect(tableExists(db, "claim")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("apply=true with dropCondemned=false: writes claims but keeps legacy tables", async () => {
    const provider = createEmbeddingProvider("hashing");
    const report = await migrateV3({
      dbPath,
      provider,
      apply: true,
      dropCondemned: false,
      dedupeThreshold: 0.5,
    });

    expect(report.applied).toBe(true);
    expect(report.claimsWritten).toBe(4); // claims still written
    expect(report.tablesDropped).toEqual([]); // but nothing dropped

    const db = new Database(dbPath);
    try {
      // Claims landed...
      expect((db.query("SELECT COUNT(*) AS n FROM claim").get() as { n: number }).n).toBe(4);
      // ...and every condemned table is still present.
      for (const t of CONDEMNED) {
        expect(tableExists(db, t)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("dry run (default apply=false): drops nothing and writes nothing", async () => {
    const provider = createEmbeddingProvider("hashing");
    const report = await migrateV3({ dbPath, provider, dedupeThreshold: 0.5 });

    // Still computes + reports the full plan...
    expect(report.lessons).toBe(3);
    expect(report.facts).toBe(2);
    expect(report.embedded).toBe(5);
    expect(report.duplicatesMerged).toBe(1);
    // ...but mutates nothing.
    expect(report.applied).toBe(false);
    expect(report.claimsWritten).toBe(0);
    expect(report.tablesDropped).toEqual([]);

    const db = new Database(dbPath);
    try {
      const claimCount = (
        db.query("SELECT COUNT(*) AS n FROM claim").get() as { n: number }
      ).n;
      expect(claimCount).toBe(0); // nothing written
      for (const t of CONDEMNED) {
        expect(tableExists(db, t)).toBe(true); // nothing dropped
      }
    } finally {
      db.close();
    }
  });

  it("requires an explicit dbPath", async () => {
    const provider = createEmbeddingProvider("hashing");
    await expect(
      migrateV3({ dbPath: "", provider, apply: false }),
    ).rejects.toThrow(/dbPath is required/);
  });
});
