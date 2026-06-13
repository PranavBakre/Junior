// Recall evaluation harness.
//
// For every labelled case we run recall twice:
//   - ranked: the production-shaped call (small limit) -> what an agent sees.
//   - wide:   a deliberately large limit that widens every channel's candidate
//             budget (ftsRows uses limit*4, edgeRows uses limit*6) -> "could any
//             channel reach this at all".
// The gap between them is the key diagnostic: a relevant id present in the wide
// set but missing from the ranked top-k is a RANKING problem (scoring); a
// relevant id absent even from the wide set is a RETRIEVAL problem (tokenization
// or missing semantic channel). This tells us which phase of the overhaul to
// build, instead of guessing.

import type { MemoryStore } from "../store.ts";
import type { CorpusStats, EvalCase, EvalCategory } from "./corpus.ts";
import {
  classifyGap,
  firstRelevantRank,
  hitAtK,
  mean,
  percentile,
  recallAtK,
  reciprocalRank,
  type GapBucket,
} from "./metrics.ts";

export interface EvalOptions {
  rankedLimit?: number;
  candidateLimit?: number;
  k?: number;
}

export interface CaseResult {
  id: string;
  category: EvalCategory;
  rankedIds: string[];
  gap: GapBucket | "invariant";
  hitAt1: number;
  hitAt5: number;
  recallAt5: number;
  reciprocalRank: number;
  latencyMs: number;
  forbiddenViolation: boolean;
}

export interface CategoryMetrics {
  category: EvalCategory;
  cases: number;
  hitAt1: number;
  hitAt5: number;
  recallAt5: number;
  mrr: number;
  retrievalGaps: number;
  rankingGaps: number;
  forbiddenViolations: number;
}

export interface LatencyStats {
  p50: number;
  p95: number;
  max: number;
  samples: number;
}

export interface EvalReport {
  meta: {
    corpus: CorpusStats;
    rankedLimit: number;
    candidateLimit: number;
    k: number;
    /** The harness exercises recall with usage writeback ON & uncontrolled, which
     *  is itself a known eval hazard (recall mutates use_count -> future ranking). */
    writebackMode: "uncontrolled-on";
  };
  totalCases: number;
  scoredCases: number;
  overall: { hitAt1: number; hitAt5: number; recallAt5: number; mrr: number };
  decomposition: { hits: number; rankingGaps: number; retrievalGaps: number };
  forbiddenViolations: number;
  byCategory: CategoryMetrics[];
  latency: LatencyStats;
  perCase: CaseResult[];
}

function recallOptionsFor(c: EvalCase, limit: number) {
  return {
    query: c.query,
    tags: c.tags,
    entities: c.entities,
    depth: c.depth,
    limit,
    recordUsage: false, // measurement read: never mutate use_count or the recall log
  };
}

function computeForbiddenViolation(c: EvalCase, rankedIds: string[]): boolean {
  const forbidden = c.forbiddenIds ?? [];
  if (forbidden.length === 0) return false;
  const firstForbidden = rankedIds.findIndex((id) => forbidden.includes(id));
  if (c.relevantIds.length === 0) {
    // Invariant case (e.g. archived): forbidden id must not appear at all.
    return firstForbidden !== -1;
  }
  if (firstForbidden === -1) return false;
  const relevant = new Set(c.relevantIds);
  const firstRelevant = firstRelevantRank(rankedIds, relevant);
  // Violation if a forbidden id outranks every relevant id (or no relevant present).
  return firstRelevant === null || firstForbidden + 1 < firstRelevant;
}

export async function runEval(
  store: MemoryStore,
  cases: EvalCase[],
  corpus: CorpusStats,
  options: EvalOptions = {},
): Promise<EvalReport> {
  const rankedLimit = options.rankedLimit ?? 5;
  const candidateLimit = options.candidateLimit ?? 200;
  const k = options.k ?? 5;

  const perCase: CaseResult[] = [];
  const latencies: number[] = [];

  for (const c of cases) {
    const relevant = new Set(c.relevantIds);

    const start = performance.now();
    const ranked = await store.recall(recallOptionsFor(c, rankedLimit));
    const latencyMs = performance.now() - start;
    latencies.push(latencyMs);

    const wide = await store.recall(recallOptionsFor(c, candidateLimit));
    const rankedIds = ranked.map((r) => r.id);
    const wideIds = wide.map((r) => r.id);

    const isInvariant = c.relevantIds.length === 0;
    const gap: GapBucket | "invariant" = isInvariant ? "invariant" : classifyGap(rankedIds, wideIds, relevant, k);

    perCase.push({
      id: c.id,
      category: c.category,
      rankedIds,
      gap,
      hitAt1: isInvariant ? 0 : hitAtK(rankedIds, relevant, 1),
      hitAt5: isInvariant ? 0 : hitAtK(rankedIds, relevant, k),
      recallAt5: isInvariant ? 0 : recallAtK(rankedIds, relevant, k),
      reciprocalRank: isInvariant ? 0 : reciprocalRank(rankedIds, relevant),
      latencyMs,
      forbiddenViolation: computeForbiddenViolation(c, rankedIds),
    });
  }

  const scored = perCase.filter((r) => r.gap !== "invariant");
  const byCategory = aggregateByCategory(perCase);

  return {
    meta: { corpus, rankedLimit, candidateLimit, k, writebackMode: "uncontrolled-on" },
    totalCases: perCase.length,
    scoredCases: scored.length,
    overall: {
      hitAt1: mean(scored.map((r) => r.hitAt1)),
      hitAt5: mean(scored.map((r) => r.hitAt5)),
      recallAt5: mean(scored.map((r) => r.recallAt5)),
      mrr: mean(scored.map((r) => r.reciprocalRank)),
    },
    decomposition: {
      hits: scored.filter((r) => r.gap === "hit").length,
      rankingGaps: scored.filter((r) => r.gap === "ranking_gap").length,
      retrievalGaps: scored.filter((r) => r.gap === "retrieval_gap").length,
    },
    forbiddenViolations: perCase.filter((r) => r.forbiddenViolation).length,
    byCategory,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: Math.max(0, ...latencies),
      samples: latencies.length,
    },
    perCase,
  };
}

function aggregateByCategory(perCase: CaseResult[]): CategoryMetrics[] {
  const categories = [...new Set(perCase.map((r) => r.category))];
  return categories.map((category) => {
    const rows = perCase.filter((r) => r.category === category);
    const scored = rows.filter((r) => r.gap !== "invariant");
    return {
      category,
      cases: rows.length,
      hitAt1: mean(scored.map((r) => r.hitAt1)),
      hitAt5: mean(scored.map((r) => r.hitAt5)),
      recallAt5: mean(scored.map((r) => r.recallAt5)),
      mrr: mean(scored.map((r) => r.reciprocalRank)),
      retrievalGaps: scored.filter((r) => r.gap === "retrieval_gap").length,
      rankingGaps: scored.filter((r) => r.gap === "ranking_gap").length,
      forbiddenViolations: rows.filter((r) => r.forbiddenViolation).length,
    };
  });
}

export interface BroadTagStress {
  tag: string;
  resultCount: number;
  p50: number;
  p95: number;
  max: number;
  samples: number;
}

/**
 * Times broad tag/entity recall — the doc's identified hot-path weak spot,
 * where one common tag matches thousands of rows that then seed edge traversal.
 */
export async function measureBroadTagStress(
  store: MemoryStore,
  tag: string,
  options: { samples?: number; depth?: number } = {},
): Promise<BroadTagStress> {
  const samples = options.samples ?? 5;
  const depth = options.depth ?? 2;
  const latencies: number[] = [];
  let resultCount = 0;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const results = await store.recall({ tags: [tag], depth, limit: 5, recordUsage: false });
    latencies.push(performance.now() - start);
    resultCount = results.length;
  }
  return {
    tag,
    resultCount,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    max: Math.max(0, ...latencies),
    samples,
  };
}
