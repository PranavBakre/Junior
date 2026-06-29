import type {
  ArchiveStaleClaimsOptions,
  ArchiveStaleClaimsResult,
  ClaimInput,
  ClaimRecallOptions,
  ClaimRecallResult,
  ClaimVectorExport,
  EpisodeInput,
  MemoryHealth,
  MemoryHealthOptions,
  MemoryFactInput,
  MemoryLessonInput,
  MemorySourceRecord,
  UnconsolidatedSourceRecordOptions,
} from "./types.ts";

export interface MemoryStore {
  close(): void;
  appendSourceRecord(record: MemorySourceRecord): Promise<void>;
  upsertLesson(lesson: MemoryLessonInput): Promise<void>;
  upsertFact(fact: MemoryFactInput): Promise<void>;
  // memory v3: semantic claim store + raw episode log
  upsertClaim(claim: ClaimInput): Promise<void>;
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
  /** Active claims with embeddings, deserialized to Float32Array (read-only). */
  exportClaimVectors(): Promise<ClaimVectorExport[]>;
  /**
   * Bump `last_used_at` on the given episodes — the consolidation pass calls this
   * when it reads episodes (their last contribution to a derivation). Not gated
   * here: only the genuine consolidation reader should invoke it.
   */
  markEpisodesUsed(ids: string[], now: number): Promise<void>;
  /**
   * Decay: ARCHIVE (set `active = 0`, never delete — keep provenance) claims that
   * are BOTH stale AND low-value. Batch/offline only, never a hot-path TTL.
   */
  archiveStaleClaims(options: ArchiveStaleClaimsOptions): Promise<ArchiveStaleClaimsResult>;
  /** Read-only decay summary per kind (corpus size, % never used, oldest use, fade candidates). */
  memoryHealth(options?: MemoryHealthOptions): Promise<MemoryHealth>;
}
