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

/**
 * Semantic derivations are typed by what the memory means, not merely by where
 * it came from. Keeping preferences and decisions distinct lets
 * recall ask for the right durable context instead of treating every memory as
 * a generic fact.
 */
export type ClaimKind =
  | "lesson"
  | "fact"
  | "preference"
  | "decision"
  | "situation-claim";

/** Hard write/read bounds for optional source-context metadata. */
export const MAX_CLAIM_SOURCE_PATH_CHARS = 2_048;
export const MAX_CLAIM_SOURCE_HEADING_CHARS = 512;
export const MAX_CLAIM_SOURCE_TEXT_CHARS = 12_000;

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

/** Read-only source-record lookup used by cumulative derivation builders. */
export interface SourceRecordQueryOptions {
  kind?: MemorySourceKind;
  actorId?: string;
  actorKind?: MemorySourceRecord["actorKind"];
  repoName?: string;
  /** Newest N matching records are returned in chronological order. */
  limit?: number;
}

export interface ClaimInput {
  id: string;
  kind: ClaimKind;
  /** ONE atomic claim — authoritative. The embedding is derived/rebuildable from it. */
  text: string;
  /**
   * Retrieval-facing projection embedded for semantic search. It may add a
   * concise situation/question cue while `text` remains the authoritative
   * memory returned to agents. Defaults to `text`.
   */
  retrievalText?: string | null;
  /** Pre-computed embedding. Stored as a Float32 LE BLOB. */
  embedding?: Float32Array | null;
  /**
   * Alternate retrieval projections for the same atomic claim. Recall scores
   * the claim by the best cosine across these vectors, while still returning
   * the authoritative `text` once. The primary `embedding` remains the
   * canonical authoritative-text vector for near-duplicate detection.
   */
  retrievalEmbeddings?: Array<{
    text: string;
    embedding: Float32Array;
  }>;
  embedModel?: string | null;
  dim?: number | null;
  repo?: string | null;
  tags?: string[];
  sourceEpisode?: string | null;
  /** File or durable document this claim was extracted from. */
  sourcePath?: string | null;
  /** Heading of the parent section containing the atomic claim. */
  sourceHeading?: string | null;
  /** Parent-section text used to expand an atomic hit with local context. */
  sourceText?: string | null;
  helpfulCount?: number;
  unhelpfulCount?: number;
  weight?: number;
  createdAt: number;
  lastUsedAt?: number | null;
  active?: boolean;
  /**
   * Skip the near-duplicate scan and waive the embedding requirement. Only
   * restore paths set it — `migrate-v3.ts`, a backup restore, and test fixtures
   * that seed a synthetic corpus. Ordinary writers must go through the guard, or
   * the store stops being the chokepoint.
   *
   * It does NOT waive the COALESCE patching of the value and vector columns: an
   * omitted `helpfulCount` / `unhelpfulCount` / `weight` / `lastUsedAt` /
   * `embedding` still keeps whatever is already stored under this id, because
   * "the caller left it out" must never mean "reset it". A restore that has to
   * write a lower or null-equivalent value must state it explicitly (0, or the
   * historical number) rather than relying on omission — omission is a patch, in
   * every write mode. For the nullable fields (`lastUsedAt`, `embedding`) an
   * explicit `null` is indistinguishable from omission and also means "keep": a
   * restore cannot CLEAR them through this path, only overwrite them.
   */
  skipDedup?: boolean;
}

/**
 * Outcome of a claim write. `id` is always the row that now HOLDS the knowledge,
 * so callers can reference it safely: on a merge that is the survivor, never the
 * id the caller asked for — that id either was never written (a fresh insert
 * that merged) or was folded into the survivor and archived (an update that
 * merged). Lets a caller — and the Stop hook — tell "stored" from "already knew
 * that".
 */
export interface ClaimWriteResult {
  id: string;
  action: "inserted" | "updated" | "merged";
  /** Survivor id when the write collapsed into an existing claim (equals `id`). */
  mergedInto?: string;
}

/** The updated usefulness counters for one claim after agent feedback. */
export interface ClaimFeedbackResult {
  id: string;
  helpfulCount: number;
  unhelpfulCount: number;
}

export interface PreRecallObservation {
  id: string;
  threadId: string | null;
  candidateIds: string[];
  selectedIds: string[];
  createdAt: number;
}

export interface CollapseDuplicateClaimsOptions {
  /** The claim that keeps its row and absorbs the duplicates' counters. */
  survivorId: string;
  /** Claims to ARCHIVE (`active = 0`) after folding their counters into the survivor. */
  duplicateIds: string[];
}

export interface CollapseDuplicateClaimsResult {
  /** Ids actually flipped to `active = 0` — already-archived duplicates are skipped. */
  archivedIds: string[];
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
  /**
   * Internal hot-path scope for durable operational guidance. Includes lessons,
   * preferences, decisions, and legacy procedure facts; excludes contextual or
   * untyped facts, curated/routing facts, and situation claims. Applied by the
   * store before either retrieval channel is ranked.
   */
  guidanceOnly?: boolean;
  tags?: string[];
  /** Match any requested tag by default, or require every tag for trusted scopes. */
  tagMatch?: "any" | "all";
  /** Absolute epoch-ms lower bound: only claims with created_at >= sinceMs. */
  sinceMs?: number;
}

export interface ClaimRecallOptions {
  /**
   * PRE-COMPUTED query embedding. recallClaims NEVER embeds — embedding happens
   * at the boundary (the caller). When absent, recall falls back to lexical-only.
   */
  queryVector?: Float32Array;
  /**
   * Original natural-language query for the lexical retrieval channel. When
   * supplied with queryVector, an explicit exact anchor activates fusion of the
   * independent vector and lexical ranks. When supplied alone, recall is
   * lexical-only.
   */
  queryText?: string;
  /** Optional raw-channel floors applied before `limit` slices the result set. */
  minCosine?: number;
  minLexicalScore?: number;
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
  /** Exact-token/phrase coverage in [0, 1], or null without queryText. */
  lexicalScore: number | null;
  sourceEpisode: string | null;
  sourcePath: string | null;
  sourceHeading: string | null;
  sourceText: string | null;
  helpfulCount: number;
  unhelpfulCount: number;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface RecallLogInput {
  query: string;
  tags?: string[];
  entityRefs?: string[];
  kinds?: string[];
  callerIntent?: string | null;
  returnedIds: string[];
  createdAt?: number;
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
  /** Value signal — the galaxy view sizes/brightens a star by it. */
  weight: number;
  createdAt: number;
  lastUsedAt: number | null;
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
  /**
   * Compute the near-duplicate rate (default true). It is an ALL-PAIRS cosine
   * scan within each dedup scope — O(n²) in corpus size, seconds at a few
   * thousand claims — so a latency-sensitive caller can turn it off and get
   * `null` counts instead.
   */
  includeNearDuplicates?: boolean;
  /** Cosine threshold for the near-duplicate rate. Defaults to the store's configured one. */
  dedupThreshold?: number;
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
  /**
   * Active claims of this kind that have at least one twin at/above the dedup
   * threshold INSIDE their own dedup scope (same kind, same repo). Scoped
   * deliberately: the sweep archives duplicates rather than deleting them, so a
   * corpus-wide measurement would fail against its own success condition.
   * `null` when the scan was skipped; always `null` for `"episode"`.
   */
  nearDuplicates: number | null;
  /**
   * `nearDuplicates` over the EMBEDDED active claims of this kind — not over
   * `total`. Only a vector-carrying row can be counted as a twin, so dividing by
   * a corpus that still holds vector-less legacy rows would understate the rate.
   * 0 when nothing of this kind is embedded, `null` when the scan was skipped.
   */
  nearDuplicateRate: number | null;
}

export interface MemoryHealth {
  generatedAt: number;
  olderThanMs: number;
  maxWeight: number;
  /** Cosine threshold the near-duplicate counts were measured at. */
  dedupThreshold: number;
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
