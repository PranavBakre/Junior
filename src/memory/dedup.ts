// Shared claim-dedup policy (docs/features/claim-dedup-write-guard.md).
//
// The threshold and the winner ordering live here rather than in the store so
// the write guard, the consolidation engine, and the offline backfill sweep all
// judge "same claim" by the same rule. A sweep that clustered differently from
// the guard would keep re-collapsing rows the guard had just accepted.
//
// KNOWN GAP, not fixed here: the similarity FUNCTION is still forked. The store's
// `cosineSim` (`sqlite.ts`) and the consolidation engine's `cosine`
// (`consolidation/consolidate.ts`) are byte-identical duplicates. That sits badly
// against this module's whole point — the components agree on the threshold, the
// winner ordering, and the scope, then each brings its own cosine, so editing one
// silently desynchronizes the judgement. Worth hoisting in here; deliberately not
// done as a late edit on the dedup-guard branch, where a numerical change is the
// hardest kind to review.

/** Cosine at/above which two claims are treated as near-duplicates. */
export const DEFAULT_DEDUP_THRESHOLD = 0.92;

/**
 * Read the configured cosine threshold. Surfaces as `MEMORY_DEDUP_THRESHOLD`
 * so retuning it is a config move, not a code move (§Threshold). Processes that
 * never load `Config` — the MCP server subprocess and the memory CLI — read the
 * env directly through this helper; `loadConfig` parses the same variable.
 *
 * An unparseable or out-of-range value falls back to the default rather than
 * throwing: a typo must not take the write path down, and 0.92 is safe (it
 * merges strictly less than a lower threshold would).
 */
export function resolveDedupThreshold(
  raw: string | undefined = process.env.MEMORY_DEDUP_THRESHOLD,
): number {
  if (raw == null || raw.trim() === "") return DEFAULT_DEDUP_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_DEDUP_THRESHOLD;
  }
  return parsed;
}

/** The fields the winner ordering needs — satisfied by claim rows and vector exports alike. */
export interface DedupCandidate {
  id: string;
  weight: number;
  createdAt: number;
}

/**
 * Deterministic winner ordering for a set of near-duplicates: highest `weight`,
 * then oldest `created_at`, then lowest `id`. Resolved any other way the outcome
 * depends on row order, which makes the sweep non-reproducible.
 *
 * Use as a `sort` comparator — the first element after sorting is the survivor.
 */
export function compareDedupWinner(a: DedupCandidate, b: DedupCandidate): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Dedup scope key: two claims may only merge when they share a `kind` AND a
 * `repo`. Merging a repo-specific claim into a global one leaks that repo's
 * convention into every other repo's recall; merging a global one down into a
 * repo narrows knowledge that currently applies everywhere. `null` (global) is
 * therefore its own scope, not a wildcard.
 */
export function dedupScopeKey(kind: string, repo: string | null): string {
  // JSON-encoded rather than concatenated so a repo literally named "global"
  // (or one containing a separator) cannot collide with the global scope.
  return JSON.stringify([kind, repo]);
}
