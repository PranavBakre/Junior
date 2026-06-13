// Pure ranking-quality metrics for memory recall evaluation.
//
// All functions operate on an ordered list of retrieved ids plus the set of
// ids that are actually relevant for a query. They are deliberately free of
// any store/database dependency so they can be unit-tested in isolation and
// reused by both the test suite and the CLI report runner.

/** 1 if any relevant id appears in the top-k retrieved ids, else 0. */
export function hitAtK(retrieved: string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  return retrieved.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

/** Fraction of relevant ids that appear in the top-k retrieved ids. */
export function recallAtK(retrieved: string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = new Set(retrieved.slice(0, k));
  let hits = 0;
  for (const id of relevant) if (top.has(id)) hits++;
  return hits / relevant.size;
}

/** Reciprocal of the rank of the first relevant id (0 if none retrieved). */
export function reciprocalRank(retrieved: string[], relevant: ReadonlySet<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/** 1-based rank of the first relevant id, or null if it never appears. */
export function firstRelevantRank(retrieved: string[], relevant: ReadonlySet<string>): number | null {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) return i + 1;
  }
  return null;
}

/**
 * Nearest-rank percentile over a sample of numbers (e.g. latencies in ms).
 * `p` is in [0, 100]. Returns 0 for an empty sample.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Classifies a single query outcome into the decomposition bucket that tells
 * us *which* part of the pipeline to fix:
 *   - "hit"           : a relevant id made the final ranked top-k.
 *   - "ranking_gap"   : a relevant id was reachable as a candidate (wide net)
 *                       but did not survive into the ranked top-k -> scoring problem.
 *   - "retrieval_gap" : no relevant id was reachable even with a wide candidate
 *                       net -> retrieval problem (tokenization / vector).
 */
export type GapBucket = "hit" | "ranking_gap" | "retrieval_gap";

export function classifyGap(
  rankedTopK: string[],
  candidateWide: string[],
  relevant: ReadonlySet<string>,
  k: number,
): GapBucket {
  if (hitAtK(rankedTopK, relevant, k) === 1) return "hit";
  if (candidateWide.some((id) => relevant.has(id))) return "ranking_gap";
  return "retrieval_gap";
}
