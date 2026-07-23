export type MemorySourceKind =
  | "slack_message"
  | "runner_output"
  | "routing_decision"
  | "routing_correction"
  | "ingestion_correction"
  | "curated_fact"
  | "manual_correction";

export type MemoryNodeKind =
  | "event"
  | "lesson"
  | "summary"
  | "fact"
  | "procedure"
  | "routing_memory"
  | "entity"
  | "tag";

export type SearchableMemoryKind = Exclude<MemoryNodeKind, "entity" | "tag">;

export interface MemorySourceRecord {
  id: string;
  kind: MemorySourceKind;
  channelId?: string | null;
  threadId?: string | null;
  slackTs?: string | null;
  sourceUrl?: string | null;
  actorId?: string | null;
  actorKind?: "human" | "junior" | "agent" | "bot" | "system" | null;
  agentName?: string | null;
  repoName?: string | null;
  body: string;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
}

export interface MemoryLessonInput {
  id: string;
  title: string;
  body: string;
  appliesWhen?: string | null;
  importance?: number;
  createdAt: number;
  sourceIds?: string[];
  tags?: string[];
  entities?: Array<{ name: string; kind: string }>;
}

export interface MemoryFactInput {
  id: string;
  kind: "curated_fact" | "routing_memory" | "procedure";
  title?: string | null;
  body: string;
  confidence?: number;
  importance?: number;
  createdAt: number;
  sourceIds?: string[];
  tags?: string[];
  entities?: Array<{ name: string; kind: string }>;
}

// --- memory v3: claims (semantic, embedded) + episodes (raw affect log) ---

export type ClaimKind = "lesson" | "fact" | "situation-claim";

/**
 * Options for the consolidation engine's read of raw source records that have
 * not yet been folded into a derivation (`consolidated_at IS NULL`). Oldest
 * first; optionally scoped to a single thread so a per-session consolidation
 * pass only sees its own turns.
 */
export interface UnconsolidatedSourceRecordOptions {
  /** Only return records for this thread. */
  threadId?: string;
  /** Cap the number of records returned (the oldest N). */
  limit?: number;
}

export interface ClaimInput {
  id: string;
  kind: ClaimKind;
  /** ONE atomic claim — authoritative. The embedding is derived/rebuildable from it. */
  text: string;
  /** Pre-computed embedding. Stored as a Float32 LE BLOB. */
  embedding?: Float32Array | null;
  embedModel?: string | null;
  dim?: number | null;
  repo?: string | null;
  tags?: string[];
  sourceEpisode?: string | null;
  helpfulCount?: number;
  unhelpfulCount?: number;
  weight?: number;
  createdAt: number;
  lastUsedAt?: number | null;
  active?: boolean;
}

export interface ClaimRecallFilters {
  repo?: string;
  /**
   * With `repo` set, also include repo-less (global) claims — "this repo or
   * global, never other repos". Without `repo`, has no effect. Used by
   * pre-recall scoping, where excluding global lessons would gut recall.
   */
  repoIncludeGlobal?: boolean;
  kind?: ClaimKind;
  /**
   * Narrow fact claims to their legacy semantic subtype. Procedure, routing,
   * and curated-fact rows are mirrored into v3 as `kind = "fact"`; this filter
   * preserves subtype-aware retrieval without duplicating their embeddings.
   */
  factKind?: MemoryFactInput["kind"];
  tags?: string[];
  /** Absolute epoch-ms lower bound: only claims with created_at >= sinceMs. */
  sinceMs?: number;
}

export interface ClaimRecallOptions {
  /**
   * PRE-COMPUTED query embedding. recallClaims NEVER embeds — embedding happens
   * at the boundary (the caller). When absent, recall falls back to FTS-only.
   */
  queryVector?: Float32Array;
  filters?: ClaimRecallFilters;
  limit?: number;
  /**
   * When true (the DEFAULT), bump `last_used_at = now` on the returned claims —
   * the genuine-production-recall signal that drives decay. Eval/replay, the
   * dashboard, and any visualization/admin read MUST pass false, or inspection
   * traffic makes everything look "fresh" and the fade signal self-pollutes
   * (the same Phase-0 footgun already fixed for legacy `recall()`). Mirrors
   * `MemoryRecallOptions.recordUsage`.
   */
  recordUsage?: boolean;
}

export interface ClaimRecallResult {
  id: string;
  kind: ClaimKind;
  /** Original memory_fact subtype when this claim was mirrored from one. */
  factKind?: MemoryFactInput["kind"] | null;
  text: string;
  repo: string | null;
  tags: string[];
  weight: number;
  score: number;
  /** Cosine against queryVector, or null when no queryVector / no embedding. */
  cosine: number | null;
  sourceEpisode: string | null;
  helpfulCount: number;
  unhelpfulCount: number;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * One active claim with its embedding deserialized into a Float32Array. Used by
 * read-only consumers (e.g. the dashboard's 2D projection view) that need the
 * raw vectors rather than a cosine-ranked recall result.
 */
export interface ClaimVectorExport {
  id: string;
  kind: ClaimKind;
  text: string;
  repo: string | null;
  tags: string[];
  vector: Float32Array;
}

// --- memory v3: decay / forgetting (§7.1) ---------------------------------

export interface ArchiveStaleClaimsOptions {
  /**
   * Age cutoff in ms. A claim is STALE when its `last_used_at` is older than
   * `now - olderThanMs`, OR it was never used and its `created_at` is older than
   * that cutoff.
   */
  olderThanMs: number;
  /**
   * Value ceiling. Only claims with `weight <= maxWeight` are eligible — a fade
   * candidate must be stale AND low-value. Age alone never forgets: a rarely
   * needed but high-weight claim survives.
   */
  maxWeight: number;
  /** Clock; defaults to `Date.now()` at the call site. */
  now?: number;
}

export interface ArchiveStaleClaimsResult {
  /** Ids of the claims flipped to `active = 0` (ARCHIVED, never deleted). */
  archivedIds: string[];
}

export interface MemoryHealthOptions {
  now?: number;
  /** Age cutoff used to compute the fade-candidate count. Defaults to 90 days. */
  olderThanMs?: number;
  /** Value ceiling used to compute the fade-candidate count. Defaults to 0.5. */
  maxWeight?: number;
}

export interface MemoryHealthKind {
  /** A claim kind, or `"episode"` for the raw affect log. */
  kind: ClaimKind | "episode";
  /** Total rows for this kind (active claims; all episodes). */
  total: number;
  /** Rows that have never been used (`last_used_at IS NULL`). */
  neverUsed: number;
  /** `neverUsed / total`, 0 when empty. */
  pctNeverUsed: number;
  /** Oldest `last_used_at` across used rows, or null when none are used. */
  oldestLastUsedAt: number | null;
  /**
   * Current fade-candidate count under the supplied (or default) cutoff/ceiling.
   * Episodes are never value-archived, so this is always 0 for `"episode"`.
   */
  fadeCandidates: number;
}

export interface MemoryHealth {
  generatedAt: number;
  olderThanMs: number;
  maxWeight: number;
  kinds: MemoryHealthKind[];
}

export interface EpisodeInput {
  id: string;
  /** Who said/did it (entity ref, e.g. pranav:person). */
  actor?: string | null;
  /** Entities this episode is ABOUT (multi-subject). */
  subjects?: string[];
  /** The utterance / event, verbatim-ish. Also the backing source-record body. */
  what: string;
  emotion?: string | null;
  intensity?: number | null;
  valence?: number | null;
  trigger?: string | null;
  response?: string | null;
  salience?: number | null;
  /** Which derivation ids this fed (provenance). */
  consolidatedInto?: string[];
  createdAt: number;
  // Backing source-record fields (an episode extends memory_source_record).
  sourceKind?: MemorySourceKind;
  channelId?: string | null;
  threadId?: string | null;
  slackTs?: string | null;
  sourceUrl?: string | null;
  actorId?: string | null;
  actorKind?: "human" | "junior" | "agent" | "bot" | "system" | null;
  agentName?: string | null;
  repoName?: string | null;
  metadata?: Record<string, unknown> | null;
}
