import type {
  ArchiveStaleClaimsOptions,
  ArchiveStaleClaimsResult,
  ClaimFeedbackResult,
  ClaimInput,
  ClaimRecallOptions,
  ClaimRecallResult,
  ClaimVectorExport,
  ClaimWriteResult,
  CollapseDuplicateClaimsOptions,
  CollapseDuplicateClaimsResult,
  EpisodeInput,
  MemoryHealth,
  MemoryHealthOptions,
  MemoryFactInput,
  MemoryLessonInput,
  MemorySourceRecord,
  RecallLogInput,
  PreRecallObservation,
  SourceRecordQueryOptions,
  UnconsolidatedSourceRecordOptions,
} from "./types.ts";

export interface MemoryStore {
  close(): void;
  appendSourceRecord(record: MemorySourceRecord): Promise<void>;
  /** Recent raw evidence, including records already consumed by thread consolidation. */
  listSourceRecords(options?: SourceRecordQueryOptions): Promise<MemorySourceRecord[]>;
  /** Distinct source actors matching the requested evidence scope. */
  listSourceActors(
    options?: Pick<SourceRecordQueryOptions, "kind" | "actorKind">,
  ): Promise<string[]>;
  /** Distinct repository labels present in raw evidence. */
  listSourceRepos(options?: Pick<SourceRecordQueryOptions, "kind">): Promise<string[]>;
  upsertLesson(lesson: MemoryLessonInput): Promise<void>;
  upsertFact(fact: MemoryFactInput): Promise<void>;
  // memory v3: semantic claim store + raw episode log
  /**
   * THE claim write chokepoint. Every writer funnels here, so the near-duplicate
   * guard lives here rather than in any one caller: the claim is scanned against
   * active claims in its own dedup scope and, on a hit, MERGED into the survivor
   * (counters bumped, `last_used_at` refreshed) instead of adding a twin row.
   * Requires a non-null `embedding` unless `skipDedup` is set — a claim with no
   * vector is both unguardable and invisible to cosine recall.
   */
  upsertClaim(claim: ClaimInput): Promise<ClaimWriteResult>;
  appendEpisode(episode: EpisodeInput): Promise<void>;
  /**
   * Raw source records the consolidation engine has not yet processed
   * (`consolidated_at IS NULL`), oldest first, optionally scoped to one thread.
   * The offline consolidation pass reads these to build derivations.
   */
  listUnconsolidatedSourceRecords(
    options?: UnconsolidatedSourceRecordOptions,
  ): Promise<MemorySourceRecord[]>;
  /**
   * Stamp `consolidated_at = now` on the given source records so a later
   * consolidation pass does not reprocess them (even when they yielded no
   * derivation — the high bar means most turns add nothing, but they are still
   * consumed exactly once).
   */
  markSourceRecordsConsolidated(ids: string[], now: number): Promise<void>;
  recallClaims(options: ClaimRecallOptions): Promise<ClaimRecallResult[]>;
  /** Append one production semantic-recall observation for offline evaluation. */
  appendRecallLog(entry: RecallLogInput): Promise<void>;
  /** Active claims with embeddings, deserialized to Float32Array (read-only). */
  exportClaimVectors(): Promise<ClaimVectorExport[]>;
  /**
   * Bump `last_used_at` on the given episodes — the consolidation pass calls this
   * when it reads episodes (their last contribution to a derivation). Not gated
   * here: only the genuine consolidation reader should invoke it.
   */
  markEpisodesUsed(ids: string[], now: number): Promise<void>;
  /**
   * Bump `last_used_at` on the given claims. Separate from `recallClaims`'s
   * `recordUsage` because a caller can only know which candidates were useful
   * AFTER it has filtered them (pre-recall synthesis): recording at retrieval
   * would keep every rejected candidate permanently fresh, and
   * `archiveStaleClaims` (stale AND low-value) could never fade it.
   */
  markClaimsUsed(ids: string[], now: number): Promise<void>;
  /** Increment the usefulness counter for claims an agent explicitly judged. */
  recordClaimFeedback(ids: string[], useful: boolean): Promise<ClaimFeedbackResult[]>;
  appendPreRecallObservation(observation: PreRecallObservation): Promise<void>;
  recordPreRecallFeedback(observationId: string, useful: boolean, claimIds?: string[]): Promise<ClaimFeedbackResult[]>;
  deletePreRecallObservationsOlderThan(before: number, limit: number): Promise<number>;
  /**
   * Decay: ARCHIVE (set `active = 0`, never delete — keep provenance) claims that
   * are BOTH stale AND low-value. Batch/offline only, never a hot-path TTL.
   */
  archiveStaleClaims(options: ArchiveStaleClaimsOptions): Promise<ArchiveStaleClaimsResult>;
  /**
   * Backfill primitive: fold a cluster of near-duplicates into one survivor —
   * sum their counters into it, inherit their newest `last_used_at`, then ARCHIVE
   * (`active = 0`, never delete) the duplicates so they remain as provenance.
   * Offline sweep only; the hot-path merge is inside `upsertClaim`.
   */
  collapseDuplicateClaims(
    options: CollapseDuplicateClaimsOptions,
  ): Promise<CollapseDuplicateClaimsResult>;
  /** Read-only decay summary per kind (corpus size, % never used, oldest use, fade candidates). */
  memoryHealth(options?: MemoryHealthOptions): Promise<MemoryHealth>;
}
