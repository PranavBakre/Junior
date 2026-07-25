import type {
  RouteFetchBookkeeping,
  RouteIdentity,
  RouteRecallOptions,
  RouteRecallResult,
  TaskRouteRecord,
  TaskRouteUpsert,
} from "../types.ts";

export interface TaskRouteStore {
  close(): void;
  /**
   * Insert or overwrite the route at `(repo, feature, task_kind)` — the unique
   * identity — atomically with its step rows. An archived row at that identity
   * is revived and overwritten rather than duplicated, so there is exactly one
   * row per identity forever. Returns the stored route (whose id is the id of
   * the pre-existing row when one was there).
   */
  upsertRoute(route: TaskRouteUpsert): Promise<TaskRouteRecord>;
  getRoute(id: string): Promise<TaskRouteRecord | null>;
  /** Exact lookup — the common case, since the dispatcher knows all three keys. */
  getRouteByIdentity(
    repo: string,
    feature: string,
    taskKind: string,
  ): Promise<TaskRouteRecord | null>;
  /**
   * Semantic lookup: cosine over `task_desc` embeddings, filtered to `repo` and
   * (when given) `feature`. ACTIVE routes only — an archived or never-activated
   * route is reachable by exact identity, never by search.
   */
  recallRoutes(options: RouteRecallOptions): Promise<RouteRecallResult[]>;
  /**
   * Every `(feature, task_kind)` stored for a repo, active or not, ordered by
   * `feature` then `task_kind` under BINARY collation, capped at `limit`.
   * Reported on a fetch miss so the caller sees the repo's actual vocabulary
   * instead of guessing at a synonym.
   *
   * Both the cap and the collation are part of the contract, not the caller's
   * job: a limit applied above the store would let two implementations return
   * different 25 rows out of the same corpus, which is exactly the kind of
   * store-shaped divergence that hid the id-collision bug.
   */
  listRouteIdentities(repo: string, limit?: number): Promise<RouteIdentity[]>;
  /**
   * Record one fetch: bump `fetch_count` / `last_used_at`, apply auto-repairs
   * (each bumping `repair_count`), and update the decay counters. One
   * transaction — a half-applied repair would leave anchors pointing at a file
   * whose fingerprints were never written.
   */
  recordFetch(routeId: string, book: RouteFetchBookkeeping): Promise<void>;
  /**
   * Bump `touch_count` on the steps a fetcher reported using. Returns the number
   * of step rows updated. Informational only — nothing is pruned on it yet.
   */
  recordUsage(routeId: string, ords: number[]): Promise<number>;
}
