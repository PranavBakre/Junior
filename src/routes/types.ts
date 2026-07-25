/**
 * Task routes — an ordered path through a codebase for one kind of task.
 *
 * See docs/features/task-routes.md. A route is deliberately narrow: it answers
 * "where do I start and in what order", not "what exists". Code indexes own the
 * exhaustive inventory; claims (memory v3) own generalizable prose. This module
 * is distinct from `src/http/routes/`, which is HTTP request routing.
 */

/**
 * Hard cap on route length. Longer than this and you have written a code index,
 * so write a code index and have the route point at it. The cap is the feature.
 */
export const MAX_ROUTE_STEPS = 8;

/**
 * Per-step verification outcome.
 *
 * `note` covers pure tooling steps (no `path`) — a dead end worth skipping has
 * nothing on disk to verify. `pending` covers an anchor that has never resolved
 * on the canonical ref: it was captured from an unmerged branch and does not
 * count as verified until a later fetch finds it.
 */
export type StepStatus =
  | "untouched"
  | "ok"
  | "drifted"
  | "moved"
  | "gone"
  | "edge-broken"
  | "pending"
  | "unknown"
  | "note";

/**
 * Which verification tier actually answered for a step. The reading agent needs
 * this to calibrate: `fingerprint` is far stronger evidence than `path-only`,
 * and an unverified route produces confidently-wrong work with no error signal.
 */
export type VerifiedBy =
  | "git-untouched"
  | "fingerprint"
  | "path-only"
  | "decl-pattern"
  | "expects-ref"
  | "none";

/** Tier index matching the table in the feature doc; null when nothing answered. */
export type VerificationTier = 0 | 1 | 2 | 3 | null;

/** One step as the calling agent writes it — anchors are resolved by the store path. */
export interface TaskRouteStepInput {
  /** Why this step, one sentence. */
  note: string;
  /** Omitted for pure tooling notes. */
  path?: string | null;
  /** Function / const / section-marker to anchor on inside `path`. */
  symbol?: string | null;
  /** "this file should still reference X" — the far end of an edge the route records. */
  expectsRef?: string | null;
}

/** One persisted step, with its resolved anchor fingerprints. */
export interface TaskRouteStepRecord {
  ord: number;
  note: string;
  path: string | null;
  symbol: string | null;
  /** The regex that located the declaration. Null while the anchor is pending. */
  declPattern: string | null;
  /** Hash of the declaration line. Null while the anchor is pending. */
  sigHash: string | null;
  /** Hash of the enclosing block. Null while the anchor is pending. */
  blockHash: string | null;
  expectsRef: string | null;
  /** Times a fetcher reported actually using this step (informational). */
  touchCount: number;
}

/** A whole route as `route_save` hands it to the store. */
export interface TaskRouteUpsert {
  id: string;
  repo: string;
  feature: string;
  taskKind: string;
  /** Natural language; embedded for semantic recall. */
  taskDesc: string;
  embedding?: Float32Array | null;
  embedModel?: string | null;
  dim?: number | null;
  /** The canonical-ref commit the anchors were resolved against. */
  verifiedSha: string;
  createdAt: number;
  active?: boolean;
  steps: TaskRouteStepRecord[];
}

export interface TaskRouteRecord {
  id: string;
  repo: string;
  feature: string;
  taskKind: string;
  taskDesc: string;
  verifiedSha: string;
  fetchCount: number;
  repairCount: number;
  /**
   * Consecutive fetches that found a majority of anchors broken with no repair.
   * Not in the doc's schema — the archival rule ("no repair has landed across N
   * fetches") needs somewhere to hold N, and deriving it from fetch_count alone
   * is not possible.
   */
  brokenFetches: number;
  createdAt: number;
  lastUsedAt: number | null;
  active: boolean;
  steps: TaskRouteStepRecord[];
}

export interface RouteRecallOptions {
  /** PRE-COMPUTED query vector. The store never embeds; the caller does. */
  queryVector?: Float32Array;
  repo: string;
  feature?: string;
  limit?: number;
}

export interface RouteRecallResult {
  route: TaskRouteRecord;
  /** Cosine against queryVector, or null when either side has no embedding. */
  cosine: number | null;
}

/** One auto-repair produced by a tier-2 resolve (or a pending anchor activating). */
export interface StepRepair {
  ord: number;
  path: string;
  declPattern: string;
  sigHash: string;
  blockHash: string;
}

/** Everything one `route_fetch` writes back, applied in a single transaction. */
export interface RouteFetchBookkeeping {
  now: number;
  /**
   * New canonical sha. Only supplied when every anchor came back clean, so a
   * still-drifted step never gets its drift signal erased by the bump.
   */
  verifiedSha?: string;
  repairs: StepRepair[];
  /** New consecutive-broken-fetch count (0 resets the streak). */
  brokenFetches: number;
  /** Flip archival / activation. Omitted leaves `active` as-is. */
  active?: boolean;
}
