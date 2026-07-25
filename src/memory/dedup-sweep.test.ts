import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDedupSweep } from "./dedup-sweep.ts";
import { SqliteMemoryStore } from "./sqlite.ts";

describe("runDedupSweep", () => {
  let tmpDir: string;
  let store: SqliteMemoryStore;

  const NEAR_A = new Float32Array([1, 0, 0, 0]);
  const NEAR_B = new Float32Array([0.95, 0.05, 0, 0]);
  const NEAR_C = new Float32Array([0.97, 0.03, 0, 0]);
  const FAR = new Float32Array([0, 1, 0, 0]);
  const now = 1_700_000_000_000;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-dedup-sweep-"));
    store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Seed a row PAST the write guard. The sweep exists for duplicates that are
   * already in the corpus, so the fixtures have to be planted the way they got
   * there — before the guard existed.
   */
  const seed = (
    id: string,
    embedding: Float32Array,
    over: { kind?: "lesson" | "fact"; repo?: string | null; weight?: number; helpfulCount?: number; createdAt?: number } = {},
  ) =>
    store.upsertClaim({
      id,
      kind: over.kind ?? "lesson",
      text: `claim ${id}`,
      embedding,
      repo: over.repo ?? null,
      weight: over.weight,
      helpfulCount: over.helpfulCount,
      createdAt: over.createdAt ?? now,
      skipDedup: true,
    });

  const activeOf = (id: string): number | undefined =>
    (store as unknown as { db: Database }).db
      .query<{ active: number }, [string]>("SELECT active FROM claim WHERE id = ?")
      .get(id)?.active;

  it("dry-runs by default: reports the plan and writes nothing", async () => {
    await seed("s-keep", NEAR_A, { weight: 5 });
    await seed("s-dup", NEAR_B, { weight: 1 });
    await seed("s-distinct", FAR);

    const report = await runDedupSweep({ store });

    expect(report.applied).toBe(false);
    expect(report.threshold).toBe(0.92);
    expect(report.claimsScanned).toBe(3);
    expect(report.clusters).toBe(1);
    expect(report.duplicatesFound).toBe(1);
    // A dry run must mutate NOTHING.
    expect(report.duplicatesArchived).toBe(0);
    expect(activeOf("s-dup")).toBe(1);

    expect(report.clusterDetail[0]).toMatchObject({
      survivorId: "s-keep",
      duplicateIds: ["s-dup"],
      kind: "lesson",
      repo: null,
    });
    expect(report.clusterDetail[0].maxCosine).toBeGreaterThanOrEqual(0.92);
  });

  it("--apply keeps the highest-weight representative, sums counters, and archives the rest", async () => {
    await seed("a-low", NEAR_A, { weight: 1, helpfulCount: 2 });
    await seed("a-high", NEAR_B, { weight: 9, helpfulCount: 3 });
    await seed("a-mid", NEAR_C, { weight: 4, helpfulCount: 5 });

    const report = await runDedupSweep({ store, apply: true });

    expect(report.applied).toBe(true);
    expect(report.duplicatesArchived).toBe(2);
    expect(report.clusterDetail[0].survivorId).toBe("a-high");

    // ARCHIVED, never deleted — the collapsed rows stay as provenance.
    expect(activeOf("a-low")).toBe(0);
    expect(activeOf("a-mid")).toBe(0);
    expect(activeOf("a-high")).toBe(1);

    const survivor = (store as unknown as { db: Database }).db
      .query<{ helpful_count: number; weight: number }, [string]>(
        "SELECT helpful_count, weight FROM claim WHERE id = ?",
      )
      .get("a-high");
    expect(survivor?.helpful_count).toBe(10);
    // The representative keeps its own weight; it does not inherit the cluster's.
    expect(survivor?.weight).toBe(9);
  });

  it("never clusters across dedup scopes", async () => {
    await seed("x-global", NEAR_A);
    await seed("x-repo", NEAR_B, { repo: "gx-backend" });
    await seed("x-fact", NEAR_C, { kind: "fact" });

    const report = await runDedupSweep({ store, apply: true });

    // Three identical-ish vectors, three different scopes → nothing collapses.
    expect(report.clusters).toBe(0);
    expect(report.duplicatesArchived).toBe(0);
    expect(activeOf("x-repo")).toBe(1);
    expect(activeOf("x-fact")).toBe(1);
  });

  it("is idempotent: a second apply finds nothing left to collapse", async () => {
    await seed("i-keep", NEAR_A, { weight: 5 });
    await seed("i-dup", NEAR_B, { weight: 1 });

    const first = await runDedupSweep({ store, apply: true });
    expect(first.duplicatesArchived).toBe(1);

    const second = await runDedupSweep({ store, apply: true });
    expect(second.clusters).toBe(0);
    expect(second.duplicatesFound).toBe(0);
    expect(second.claimsScanned).toBe(1);
  });

  it("honors an explicit threshold", async () => {
    // These two sit at cosine 0.9487 — inside a 0.90 gate, outside a 0.99 one.
    await seed("t-a", NEAR_A);
    await seed("t-b", new Float32Array([0.9, 0.3, 0, 0]));

    const strict = await runDedupSweep({ store, threshold: 0.99 });
    expect(strict.clusters).toBe(0);

    const loose = await runDedupSweep({ store, threshold: 0.9 });
    expect(loose.threshold).toBe(0.9);
    expect(loose.clusters).toBe(1);
  });
});
