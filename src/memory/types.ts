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

export interface MemoryEventInput {
  id: string;
  sourceRecordId: string;
  threadId: string;
  body: string;
  summaryId?: string | null;
  outcome?: string | null;
  importance?: number;
  createdAt: number;
  sourceTs?: string | null;
  sourceUrl?: string | null;
  tags?: string[];
  entities?: Array<{ name: string; kind: string }>;
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

export interface MemoryEdgeInput {
  srcId: string;
  dstId: string;
  type:
    | "lesson_from"
    | "same_topic"
    | "follows_up"
    | "contradicts"
    | "supersedes"
    | "merged_from"
    | "mentions"
    | "tagged_as"
    | "applies_to"
    | string;
  weight?: number;
  directed?: boolean;
  createdAt: number;
}

export interface MemoryLessonUpdate {
  title?: string | null;
  body?: string | null;
  appliesWhen?: string | null;
  importance?: number | null;
  addSourceIds?: string[];
  addTags?: string[];
  addEntities?: Array<{ name: string; kind: string }>;
}

export interface MemoryFactUpdate {
  kind?: "curated_fact" | "routing_memory" | "procedure" | null;
  title?: string | null;
  body?: string | null;
  confidence?: number | null;
  importance?: number | null;
  addSourceIds?: string[];
  addTags?: string[];
  addEntities?: Array<{ name: string; kind: string }>;
}

export interface MemoryMergeResult {
  mergedId: string;
  kind: "lesson" | "fact";
  sourceIds: string[];
  supersededIds: string[];
}

export interface MemoryRecallOptions {
  query?: string;
  tags?: string[];
  entities?: string[];
  kinds?: SearchableMemoryKind[];
  limit?: number;
  depth?: number;
  includeInactive?: boolean;
  includeInvalid?: boolean;
  /**
   * When false, skip the use_count/last_used_at writeback AND the recall_log
   * insert. Eval, replay, and any measurement read MUST pass false so it does
   * not mutate ranking signals or pollute the query log. Defaults to true so
   * production recalls keep recording usage.
   */
  recordUsage?: boolean;
  /**
   * Coarse label for why this recall ran (e.g. "mcp_tool", "http_dashboard").
   * Persisted to recall_log so replay can separate agent-driven recall (the
   * real signal) from dashboard browsing (noise).
   */
  callerIntent?: string;
}

export interface MemorySearchResult {
  id: string;
  kind: SearchableMemoryKind;
  title: string | null;
  body: string;
  outcome: string | null;
  score: number;
  reasons: string[];
  sourceIds: string[];
}

export interface IngestionClassificationInput {
  eventId: string;
  inputText: string;
  extractedMentions: string[];
  assignedTags: string[];
  assignedEventTypes: string[];
  createdEdges: Array<{ src: string; dst: string; type: string }>;
  extractor: "capture" | "heuristic" | "llm" | "manual" | "learned_rule";
  confidence: number;
  createdAt: number;
}

export interface IngestionCorrectionInput {
  eventId: string;
  field: "tag" | "event_type" | "edge" | "promotion" | "archive" | "routing_fact" | "validity";
  incorrectValue?: string | null;
  correctValue?: string | null;
  correctedBy: "user" | "agent" | "reviewer";
  createdAt: number;
}

export interface ConsolidationDecisionRecord {
  id: string;
  eventId: string;
  action: "promote_lesson" | "promote_fact" | "promote_routing_memory" | "archive" | "mark_stale" | "propose_rule" | "prune_edges" | "summarize";
  reason: string;
  sourceIds: string[];
  extractor: "heuristic" | "llm" | "manual" | "learned_rule";
  createdAt: number;
}

export interface CandidateRuleInput {
  id: string;
  status?: "draft" | "accepted" | "rejected";
  domain: "tag" | "event_type" | "edge" | "promotion" | "archive" | "routing_fact";
  ruleText: string;
  positiveExampleIds: string[];
  negativeExampleIds: string[];
  precision?: number | null;
  recall?: number | null;
  createdAt: number;
}

export interface ConsolidationOptions {
  now?: number;
  archiveBeforeMs?: number;
  lowImportanceThreshold?: number;
  repeatedCorrectionThreshold?: number;
}

export interface ConsolidationResult {
  decisions: ConsolidationDecisionRecord[];
  promotedMemoryIds: string[];
  archivedEventIds: string[];
  proposedRuleIds: string[];
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
  kind?: ClaimKind;
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
  /** Lexical/identifier escape hatch (slugs, file paths, PR numbers). */
  ftsQuery?: string;
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
  text: string;
  repo: string | null;
  tags: string[];
  weight: number;
  score: number;
  /** Cosine against queryVector, or null when no queryVector / no embedding. */
  cosine: number | null;
  ftsMatched: boolean;
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
