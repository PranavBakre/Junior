import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../sqlite.ts";
import { seedEvalCorpus, STRESS_TAG } from "./corpus.ts";
import { measureBroadTagStress, runEval, type CategoryMetrics, type EvalReport } from "./harness.ts";
import { classifyGap, hitAtK, percentile, recallAtK, reciprocalRank } from "./metrics.ts";

// --- pure metric math --------------------------------------------------------
describe("recall eval metrics", () => {
  it("hit@k and recall@k respect the cutoff", () => {
    const ranked = ["a", "b", "c", "d"];
    const relevant = new Set(["c", "x"]);
    expect(hitAtK(ranked, relevant, 2)).toBe(0);
    expect(hitAtK(ranked, relevant, 3)).toBe(1);
    expect(recallAtK(ranked, relevant, 3)).toBeCloseTo(0.5, 5);
    expect(recallAtK(ranked, relevant, 4)).toBeCloseTo(0.5, 5); // x never retrieved
  });

  it("reciprocal rank uses the first relevant position", () => {
    expect(reciprocalRank(["a", "b", "c"], new Set(["b"]))).toBeCloseTo(0.5, 5);
    expect(reciprocalRank(["a", "b"], new Set(["z"]))).toBe(0);
  });

  it("percentile uses nearest-rank", () => {
    const xs = [10, 20, 30, 40, 50];
    expect(percentile(xs, 50)).toBe(30);
    expect(percentile(xs, 95)).toBe(50);
    expect(percentile([], 95)).toBe(0);
  });

  it("classifyGap separates ranking gaps from retrieval gaps", () => {
    const relevant = new Set(["target"]);
    // present in ranked top-k -> hit
    expect(classifyGap(["target"], ["target"], relevant, 5)).toBe("hit");
    // missing from ranked but present in wide candidate net -> ranking gap
    expect(classifyGap(["other"], ["other", "target"], relevant, 5)).toBe("ranking_gap");
    // absent even from the wide net -> retrieval gap
    expect(classifyGap(["other"], ["other"], relevant, 5)).toBe("retrieval_gap");
  });
});

// --- end-to-end baseline against the real SqliteMemoryStore ------------------
describe("recall eval baseline", () => {
  let dir: string;
  let store: SqliteMemoryStore;
  let report: EvalReport;
  const byCategory = new Map<string, CategoryMetrics>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "junior-recall-eval-test-"));
    store = new SqliteMemoryStore(join(dir, "memory.db"));
    const { cases, stats } = await seedEvalCorpus(store, Date.now());
    report = await runEval(store, cases, stats);
    for (const c of report.byCategory) byCategory.set(c.category, c);
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Hard invariants: these must hold on every pipeline version.
  it("lexical / tag / entity / structured queries always hit", () => {
    for (const cat of ["lexical", "tag", "entity", "edge", "precision", "correction"]) {
      expect(byCategory.get(cat)?.hitAt5).toBe(1);
    }
  });

  it("never surfaces stale or archived memories (no forbidden violations)", () => {
    expect(report.forbiddenViolations).toBe(0);
    expect(byCategory.get("stale")?.hitAt5).toBe(1); // current memory still surfaces
  });

  // Baseline snapshot: documents the current gap and acts as a regression gate.
  // When Phase 1 (tokenization) / Phase 4 (vectors) land, these should improve
  // and the snapshot is intentionally updated.
  it("paraphrase queries miss entirely, and the misses are RETRIEVAL gaps", () => {
    const para = byCategory.get("paraphrase");
    expect(para?.cases).toBe(3);
    expect(para?.hitAt5).toBe(0); // current FTS (strict-AND, no stemming) cannot reach paraphrases
    expect(para?.retrievalGaps).toBe(3); // and they are NOT ranking gaps -> scoring won't fix this
    expect(para?.rankingGaps).toBe(0);
  });

  it("scoring is not the current bottleneck (zero ranking gaps overall)", () => {
    expect(report.decomposition.rankingGaps).toBe(0);
    expect(report.decomposition.retrievalGaps).toBe(3);
  });

  it("overall recall holds at or above the current baseline floor", () => {
    expect(report.overall.hitAt5).toBeGreaterThanOrEqual(0.75);
    expect(report.overall.mrr).toBeGreaterThanOrEqual(0.75);
  });

  // Latency gates (doc: broad tag/entity p95 < 75ms on 10k rows; this corpus is
  // smaller, so the ceiling is generous and just guards against blowups).
  it("ranked recall p95 stays well under the latency gate", () => {
    expect(report.latency.p95).toBeLessThan(100);
  });

  it("broad-tag recall stays bounded despite many rows on one tag", async () => {
    const stress = await measureBroadTagStress(store, STRESS_TAG);
    expect(stress.resultCount).toBeGreaterThan(0);
    expect(stress.p95).toBeLessThan(100);
  });
});

// --- eval hazards the doc calls out ------------------------------------------
describe("recall eval hazards", () => {
  it("recall writeback + recall_log default ON; recordUsage:false disables both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-recall-hazard-"));
    const store = new SqliteMemoryStore(join(dir, "memory.db"));
    try {
      const now = Date.now();
      await store.appendSourceRecord({ id: "src-h", kind: "curated_fact", body: "Worktrees live in target repos.", createdAt: now });
      await store.upsertFact({ id: "fact-h", kind: "curated_fact", body: "Worktrees live in target repos.", createdAt: now, sourceIds: ["src-h"] });

      const db = (store as unknown as { db: Database }).db;
      const readCount = () =>
        db.query<{ use_count: number }, [string]>("SELECT use_count FROM memory_fact WHERE id = ?").get("fact-h")?.use_count;
      const readLogRows = () =>
        db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM recall_log").get()?.c ?? 0;

      // Default (recordUsage omitted) — production behaviour: bumps use_count AND logs.
      expect(readCount()).toBe(0);
      await store.recall({ query: "worktrees target repos" });
      expect(readCount()).toBe(1); // a benchmark that calls recall would mutate ranking signals
      expect(readLogRows()).toBe(1);

      // recordUsage:false — the eval/measurement guard: no writeback, no log row.
      await store.recall({ query: "worktrees target repos", recordUsage: false });
      expect(readCount()).toBe(1); // unchanged
      expect(readLogRows()).toBe(1); // unchanged
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
