import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { compareDedupWinner, dedupScopeKey, resolveDedupThreshold } from "./dedup.ts";
import type { MemoryStore } from "./store.ts";
import type {
  ArchiveStaleClaimsOptions,
  ArchiveStaleClaimsResult,
  ClaimFeedbackResult,
  ClaimInput,
  ClaimKind,
  ClaimRecallOptions,
  ClaimRecallResult,
  ClaimVectorExport,
  ClaimWriteResult,
  CollapseDuplicateClaimsOptions,
  CollapseDuplicateClaimsResult,
  EpisodeInput,
  MemoryHealth,
  MemoryHealthKind,
  MemoryHealthOptions,
  MemoryFactInput,
  MemoryLessonInput,
  MemorySourceRecord,
  PreRecallObservation,
  RecallLogInput,
  SearchableMemoryKind,
  SourceRecordQueryOptions,
  UnconsolidatedSourceRecordOptions,
} from "./types.ts";
import {
  MAX_CLAIM_SOURCE_HEADING_CHARS,
  MAX_CLAIM_SOURCE_PATH_CHARS,
  MAX_CLAIM_SOURCE_TEXT_CHARS,
} from "./types.ts";

/**
 * Weight added to the survivor each time a near-duplicate write merges into it.
 * Small and additive: rediscovery should nudge a claim up the recall ranking,
 * not let a chatty writer inflate one claim past everything else.
 */
const CLAIM_MERGE_WEIGHT_BUMP = 0.1;

/**
 * Hard ceiling the merge bump may raise a survivor's weight to.
 *
 * The bump above is additive and a merge writes no row for the twin, so the SAME
 * input text merges again on every call: without a ceiling a Stop hook or an
 * agent that re-asserts one lesson each session adds +0.1 per session forever.
 * `recallClaims` scores `cosine * weight`, so an unbounded weight lets a
 * cosine-0.2 claim outrank a cosine-0.9 one — that is a live recall-ranking
 * defect today. At 2.0 a rediscovered claim can outrank a fresh one of at most
 * double its cosine, and no further; repeated merges converge.
 *
 * NOTE what does NOT save you here: nothing in this codebase ever decrements a
 * claim's `weight` — there is no downweight-on-unhelpful and no time decay — and
 * `archiveStaleClaims` is report-first and only retires claims behind an
 * explicit `apply:true` gate. It is not a hot-path TTL; operators review the
 * scheduled report before applying the owned age/value thresholds. The ceiling
 * remains the only bound on merge bumps. See docs/features/claim-dedup-write-guard.md.
 *
 * The cap only ever holds a bump DOWN; it never pulls an explicitly-set higher
 * weight back to the ceiling. `helpful_count` is deliberately NOT capped — it
 * feeds no ranking, and the honest count of rediscoveries is the useful signal.
 */
const CLAIM_MERGE_WEIGHT_CEILING = 2.0;
const MAX_CLAIM_RETRIEVAL_EMBEDDINGS = 8;

const LEXICAL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does",
  "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "should",
  "that", "the", "this", "to", "was", "what", "when", "where", "which",
  "with", "would", "you",
]);

function lexicalTerms(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}._/#:-]*/gu) ?? [];
  return unique(tokens.filter((token) => !LEXICAL_STOP_WORDS.has(token)));
}

function normalizeLexicalPhrase(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}._/#:-]+/gu, " ").trim();
}

/**
 * Equal-rank lexical fusion is useful for exact anchors, but ordinary shared
 * prose can pull a semantically wrong claim above the right paraphrase. Keep
 * lexical scoring available for diagnostics/floors, and fuse it into ordering
 * only when the query visibly asks for exact-token behaviour.
 */
export function queryHasExactLexicalAnchor(value: string): boolean {
  return (
    /https?:\/\/|www\./i.test(value) ||
    /[`"]([^`"\n]{2,})[`"]/.test(value) ||
    /(?:^|\s)(?:\.{0,2}\/|\/)[\p{L}\p{N}_.\-/]+/u.test(value) ||
    /\b[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+\b/u.test(value) ||
    /(?:^|\s)--?[a-z][a-z0-9-]*/i.test(value) ||
    /(?:^|\s)#\d+\b/.test(value) ||
    /\b(?:[A-Z][A-Z0-9]*[_./:-][A-Z0-9_./:-]*|[a-zA-Z_]+\d+[a-zA-Z0-9_.:/-]*)\b/.test(value)
  );
}

/** Exact-token coverage, with extra weight for identifiers, paths, and numbers. */
function lexicalRelevance(query: string, documents: Array<string | null | undefined>): number {
  const queryTerms = lexicalTerms(query);
  if (queryTerms.length === 0) return 0;
  const document = documents.filter(Boolean).join("\n");
  const documentTerms = new Set(lexicalTerms(document));
  const termWeight = (term: string): number =>
    /[\d._/#:-]/.test(term) || term.length >= 12 ? 4 : 1;
  const totalWeight = queryTerms.reduce((sum, term) => sum + termWeight(term), 0);
  const matchedWeight = queryTerms.reduce(
    (sum, term) => sum + (documentTerms.has(term) ? termWeight(term) : 0),
    0,
  );
  let score = matchedWeight / totalWeight;
  const phrase = normalizeLexicalPhrase(query);
  const singleOrdinaryTerm =
    queryTerms.length === 1 && termWeight(queryTerms[0] ?? "") === 1;
  if (
    !singleOrdinaryTerm &&
    phrase.length >= 4 &&
    normalizeLexicalPhrase(document).includes(phrase)
  ) {
    score = 1;
  }
  // A lone ordinary word is grep-like but not strong enough to bypass the
  // calibrated cosine floor. Exact identifiers/paths keep their full score.
  if (singleOrdinaryTerm) score *= 0.5;
  return score;
}

/** Normalized reciprocal-rank fusion. A rank-1 hit in both channels scores 1. */
function fusedRankScore(vectorRank: number | null, lexicalRank: number | null): number {
  const offset = 60;
  const max = 2 / (offset + 1);
  return (
    (vectorRank == null ? 0 : 1 / (offset + vectorRank)) +
    (lexicalRank == null ? 0 : 1 / (offset + lexicalRank))
  ) / max;
}

type ClaimRow = {
  id: string;
  kind: string;
  /** Selected only by recallClaims; other claim queries do not need it. */
  fact_kind?: string | null;
  text: string;
  retrieval_text?: string | null;
  embedding: Uint8Array | null;
  embed_model: string | null;
  dim: number | null;
  repo: string | null;
  tags: string | null;
  source_episode: string | null;
  source_path?: string | null;
  source_heading?: string | null;
  source_text?: string | null;
  helpful_count: number | null;
  unhelpful_count: number | null;
  weight: number | null;
  created_at: number;
  last_used_at: number | null;
  active: number | null;
};

type SourceRecordRow = {
  id: string;
  kind: string;
  channel_id: string | null;
  thread_id: string | null;
  slack_ts: string | null;
  source_url: string | null;
  actor_id: string | null;
  actor_kind: string | null;
  agent_name: string | null;
  repo_name: string | null;
  body: string;
  metadata_json: string | null;
  created_at: number;
};

export interface SqliteMemoryStoreOptions {
  /**
   * Cosine at/above which a claim write MERGES into an existing claim instead of
   * inserting a twin. Defaults to `MEMORY_DEDUP_THRESHOLD` / 0.92.
   */
  dedupThreshold?: number;
}

export class SqliteMemoryStore implements MemoryStore {
  private db: Database;
  private dedupThreshold: number;

  constructor(dbPath: string, options: SqliteMemoryStoreOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    // Absorb write contention instead of throwing. `data/memory.db` has more than
    // one writer: the in-process consolidation sweep and any `bun run
    // src/memory/cli.ts add-lesson` a workflow shells out. With the default
    // busy_timeout of 0 the second writer fails immediately; with a timeout it
    // waits for the first one's write lock. Paired with the IMMEDIATE
    // transactions below — a busy handler cannot rescue a DEFERRED read-then-write
    // txn, whose failure mode is the non-retryable SQLITE_BUSY_SNAPSHOT.
    //
    // Per CONNECTION, not per database: any other process that opens this file
    // with its own handle (`migrate-v3.ts`, the routing-log migration) still gets
    // SQLite's default of 0. Those are operator-run with the bot stopped, so they
    // do not contend — but a new handle that runs alongside the bot needs its own
    // busy_timeout.
    this.db.run("PRAGMA busy_timeout = 5000");
    this.dedupThreshold = options.dedupThreshold ?? resolveDedupThreshold();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  async appendSourceRecord(record: MemorySourceRecord): Promise<void> {
    this.db
      .query(
        `INSERT OR IGNORE INTO memory_source_record (
          id, kind, channel_id, thread_id, slack_ts, source_url, actor_id,
          actor_kind, agent_name, repo_name, body, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.channelId ?? null,
        record.threadId ?? null,
        record.slackTs ?? null,
        record.sourceUrl ?? null,
        record.actorId ?? null,
        record.actorKind ?? null,
        record.agentName ?? null,
        record.repoName ?? null,
        record.body,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt,
      );
  }

  async listSourceRecords(options: SourceRecordQueryOptions = {}): Promise<MemorySourceRecord[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
    const rows = this.db
      .query<SourceRecordRow, [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, number]>(
        `SELECT id, kind, channel_id, thread_id, slack_ts, source_url, actor_id,
                actor_kind, agent_name, repo_name, body, metadata_json, created_at
         FROM memory_source_record
         WHERE (? IS NULL OR kind = ?)
           AND (? IS NULL OR actor_id = ?)
           AND (? IS NULL OR actor_kind = ?)
           AND (? IS NULL OR repo_name = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(
        options.kind ?? null,
        options.kind ?? null,
        options.actorId ?? null,
        options.actorId ?? null,
        options.actorKind ?? null,
        options.actorKind ?? null,
        options.repoName ?? null,
        options.repoName ?? null,
        limit,
      );
    return rows.reverse().map(rowToSourceRecord);
  }

  async listSourceActors(
    options: Pick<SourceRecordQueryOptions, "kind" | "actorKind"> = {},
  ): Promise<string[]> {
    return this.db
      .query<
        { actor_id: string },
        [string | null, string | null, string | null, string | null]
      >(
        `SELECT DISTINCT actor_id
         FROM memory_source_record
         WHERE actor_id IS NOT NULL
           AND (? IS NULL OR kind = ?)
           AND (? IS NULL OR actor_kind = ?)
         ORDER BY actor_id`,
      )
      .all(
        options.kind ?? null,
        options.kind ?? null,
        options.actorKind ?? null,
        options.actorKind ?? null,
      )
      .map((row) => row.actor_id);
  }

  async listSourceRepos(
    options: Pick<SourceRecordQueryOptions, "kind"> = {},
  ): Promise<string[]> {
    return this.db
      .query<{ repo_name: string }, [string | null, string | null]>(
        `SELECT DISTINCT repo_name
         FROM memory_source_record
         WHERE repo_name IS NOT NULL
           AND (? IS NULL OR kind = ?)
         ORDER BY repo_name`,
      )
      .all(options.kind ?? null, options.kind ?? null)
      .map((row) => row.repo_name);
  }

  async upsertLesson(lesson: MemoryLessonInput): Promise<void> {
    const importance = lesson.importance ?? 0.5;
    const txn = this.db.transaction(() => {
      this.upsertNode(lesson.id, "lesson", lesson.createdAt);
      this.db
        .query(
          `INSERT INTO lesson (id, title, body, applies_when, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             body = excluded.body,
             applies_when = excluded.applies_when,
             importance = excluded.importance`,
        )
        .run(
          lesson.id,
          lesson.title,
          lesson.body,
          lesson.appliesWhen ?? null,
          importance,
          lesson.createdAt,
        );
      this.replaceProvenance(lesson.id, lesson.sourceIds ?? []);
      this.replaceTags(lesson.id, "lesson", lesson.tags ?? []);
    });
    txn();
  }

  async upsertFact(fact: MemoryFactInput): Promise<void> {
    const importance = fact.importance ?? 0.5;
    const confidence = fact.confidence ?? 0.5;
    const nodeKind: SearchableMemoryKind =
      fact.kind === "curated_fact" ? "fact" : fact.kind;
    const txn = this.db.transaction(() => {
      this.upsertNode(fact.id, nodeKind, fact.createdAt);
      this.db
        .query(
          `INSERT INTO memory_fact (id, kind, title, body, confidence, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             title = excluded.title,
             body = excluded.body,
             confidence = excluded.confidence,
             importance = excluded.importance`,
        )
        .run(
          fact.id,
          fact.kind,
          fact.title ?? null,
          fact.body,
          confidence,
          importance,
          fact.createdAt,
        );
      this.replaceProvenance(fact.id, fact.sourceIds ?? []);
      this.replaceTags(fact.id, nodeKind, fact.tags ?? []);
    });
    txn();
  }

  // --- memory v3: claims (semantic, embedded) -------------------------------

  /**
   * THE claim write chokepoint — see docs/features/claim-dedup-write-guard.md.
   *
   * Three things happen here that used to be a caller's problem (or nobody's):
   * 1. NEAR-DUPLICATE GUARD. The claim is compared against active claims in its
   *    own dedup scope; on a hit it MERGES into the survivor instead of adding a
   *    twin row. Consolidation used to be the only writer that deduped, so
   *    `memory_add` and the CLI walked straight past it. An UPDATE that merges
   *    folds its own (now unasserted) row into the survivor and archives it.
   * 2. EMBEDDING REQUIRED. The store never embeds (callers embed at the
   *    boundary), so a vector-less claim is both unguardable and invisible to
   *    cosine recall. Reject it rather than store an unrecallable row.
   * 3. VALUE METADATA IS PATCHED, NOT OVERWRITTEN. Optional value fields are
   *    bound as NULL when the caller omits them and COALESCE'd against the
   *    stored row, so re-saving a claim by id no longer resets its accumulated
   *    weight and counters to the defaults.
   *
   * `skipDedup` waives 1 and 2 for verbatim restore writes (migrate-v3, backups).
   */
  async upsertClaim(claim: ClaimInput): Promise<ClaimWriteResult> {
    const tags = unique((claim.tags ?? []).map(normalizeName));
    const embedding = claim.embedding ?? null;
    const dim = claim.dim ?? (embedding ? embedding.length : null);
    const skipDedup = claim.skipDedup === true;
    const explicitRetrievalText = claim.retrievalText?.trim() || null;

    validateSourceField(
      "sourcePath",
      claim.sourcePath,
      MAX_CLAIM_SOURCE_PATH_CHARS,
    );
    validateSourceField(
      "sourceHeading",
      claim.sourceHeading,
      MAX_CLAIM_SOURCE_HEADING_CHARS,
    );
    validateSourceField(
      "sourceText",
      claim.sourceText,
      MAX_CLAIM_SOURCE_TEXT_CHARS,
    );

    if (!skipDedup && !embedding) {
      throw new Error(
        `upsertClaim: claim "${claim.id}" has no embedding. Embed the text at the ` +
          "caller, or set skipDedup to write a historical row verbatim.",
      );
    }
    if ((claim.retrievalEmbeddings?.length ?? 0) > MAX_CLAIM_RETRIEVAL_EMBEDDINGS) {
      throw new Error(
        `upsertClaim: at most ${MAX_CLAIM_RETRIEVAL_EMBEDDINGS} retrieval embeddings are allowed`,
      );
    }
    for (const variant of claim.retrievalEmbeddings ?? []) {
      if (!variant.text.trim()) {
        throw new Error("upsertClaim: retrieval embedding text must not be empty");
      }
      if (embedding && variant.embedding.length !== embedding.length) {
        throw new Error("upsertClaim: retrieval embedding dimensions must match the primary embedding");
      }
    }

    const blob = embedding ? serializeEmbedding(embedding) : null;
    const helpfulCount = claim.helpfulCount ?? null;
    const unhelpfulCount = claim.unhelpfulCount ?? null;
    const weight = claim.weight ?? null;
    const lastUsedAt = claim.lastUsedAt ?? null;
    const now = Date.now();

    // Scan and write in ONE transaction: a concurrent writer must not be able to
    // insert a near-duplicate between the check and the write. IMMEDIATE, not the
    // default DEFERRED: this transaction READS (the lookup below, then the full
    // corpus scan) before its first write, so under WAL a deferred txn takes a
    // read snapshot and then fails with SQLITE_BUSY_SNAPSHOT if another writer
    // commits inside that window — an error a busy handler cannot retry away.
    // Taking the write lock up front turns that into ordinary lock contention,
    // which `PRAGMA busy_timeout` absorbs.
    const txn = this.db.transaction((): ClaimWriteResult => {
      const existing = this.db
        .query<
          {
            text: string;
            retrieval_text: string | null;
            active: number | null;
            helpful_count: number | null;
            unhelpful_count: number | null;
          },
          [string]
        >(
          "SELECT text, retrieval_text, active, helpful_count, unhelpful_count FROM claim WHERE id = ?",
        )
        .get(claim.id);

      // Re-scan whenever this TEXT is new to the corpus under this id: a fresh
      // insert, an update whose text changed (a new claim wearing an old id), or
      // a re-add of an archived row — without the last case, re-adding a claim
      // the backfill sweep archived would trivially resurrect it.
      const textIsNew =
        !existing || existing.text !== claim.text || existing.active === 0;
      // An idempotent re-save that omits retrievalText must not erase a curated
      // projection or replace its paired vector with an embedding of plain text.
      // A genuinely new/revised/reactivated claim defaults to its new text.
      const preserveProjection =
        existing != null &&
        !textIsNew &&
        explicitRetrievalText == null &&
        existing.retrieval_text != null &&
        existing.retrieval_text !== existing.text;
      const retrievalText = preserveProjection
        ? (existing.retrieval_text ?? claim.text)
        : (explicitRetrievalText ?? claim.text);
      const writeBlob = preserveProjection ? null : blob;
      const writeEmbedModel = preserveProjection ? null : (claim.embedModel ?? null);
      const writeDim = preserveProjection ? null : dim;
      if (!skipDedup && embedding && textIsNew) {
        const survivor = this.findNearDuplicate(claim, embedding);
        if (survivor) {
          // Merge, don't drop. The same claim independently derived twice is
          // evidence that it matters, so the survivor gains value signal
          // (`weight`, `helpful_count`, a fresh `last_used_at`) rather than the
          // rediscovery being a silent no-op. That signal is what the decay
          // contract would read — `archiveStaleClaims` is "stale AND low-value" —
          // once anything actually calls it; today nothing does.
          //
          // When the merging write was an UPDATE of a still-ACTIVE row, that row
          // is ALSO folded in — collapseDuplicateClaims semantics: its counters
          // move to the survivor, then `active = 0`. Its text is no longer
          // asserted by anyone (the caller just replaced it), and leaving it
          // active would strand dead text in recall permanently: no later write
          // can repair it, because every subsequent edit of that id re-merges
          // exactly the same way and never rewrites the row.
          //
          // An ALREADY-ARCHIVED row is not folded. The sweep that archived it
          // moved its counters at the time, so re-folding on every re-add would
          // double-count; the plain bump below is the whole effect there.
          const absorbed = existing && existing.active !== 0 ? existing : null;
          this.db
            .query(
              `UPDATE claim
               SET helpful_count = COALESCE(helpful_count, 0) + ?,
                   unhelpful_count = COALESCE(unhelpful_count, 0) + ?,
                   weight = MAX(COALESCE(weight, 1.0), MIN(COALESCE(weight, 1.0) + ?, ?)),
                   last_used_at = ?,
                   source_path = COALESCE(source_path, ?),
                   source_heading = COALESCE(source_heading, ?),
                   source_text = COALESCE(source_text, ?)
               WHERE id = ?`,
            )
            .run(
              1 + (absorbed?.helpful_count ?? 0),
              absorbed?.unhelpful_count ?? 0,
              CLAIM_MERGE_WEIGHT_BUMP,
              CLAIM_MERGE_WEIGHT_CEILING,
              now,
              claim.sourcePath ?? null,
              claim.sourceHeading ?? null,
              claim.sourceText ?? null,
              survivor.id,
            );
          if (absorbed) {
            this.db.query("UPDATE claim SET active = 0 WHERE id = ?").run(claim.id);
          }
          return { id: survivor.id, action: "merged", mergedInto: survivor.id };
        }
      }

      this.upsertNode(claim.id, "claim", claim.createdAt);
      // The value/vector columns are COALESCE'd from the RAW bound parameter
      // rather than from `excluded`: `excluded` reflects the VALUES row after its
      // own COALESCE defaults have been applied, which would turn "caller omitted
      // it" back into 0 / 1.0 / NULL and re-introduce the erasure this fixes.
      this.db
        .query(
          `INSERT INTO claim (
            id, kind, text, retrieval_text, embedding, embed_model, dim, repo, tags, source_episode,
            source_path, source_heading, source_text, helpful_count, unhelpful_count, weight,
            created_at, last_used_at, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 1.0), ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            text = excluded.text,
            retrieval_text = excluded.retrieval_text,
            embedding = COALESCE(?, claim.embedding),
            embed_model = COALESCE(?, claim.embed_model),
            dim = COALESCE(?, claim.dim),
            repo = excluded.repo,
            tags = excluded.tags,
            source_episode = excluded.source_episode,
            source_path = CASE WHEN ? THEN excluded.source_path ELSE COALESCE(excluded.source_path, claim.source_path) END,
            source_heading = CASE WHEN ? THEN excluded.source_heading ELSE COALESCE(excluded.source_heading, claim.source_heading) END,
            source_text = CASE WHEN ? THEN excluded.source_text ELSE COALESCE(excluded.source_text, claim.source_text) END,
            helpful_count = COALESCE(?, claim.helpful_count),
            unhelpful_count = COALESCE(?, claim.unhelpful_count),
            weight = COALESCE(?, claim.weight),
            last_used_at = COALESCE(?, claim.last_used_at),
            active = excluded.active`,
        )
        .run(
          claim.id,
          claim.kind,
          claim.text,
          retrievalText,
          writeBlob,
          writeEmbedModel,
          writeDim,
          claim.repo ?? null,
          tags.length ? JSON.stringify(tags) : null,
          claim.sourceEpisode ?? null,
          claim.sourcePath ?? null,
          claim.sourceHeading ?? null,
          claim.sourceText ?? null,
          helpfulCount,
          unhelpfulCount,
          weight,
          claim.createdAt,
          lastUsedAt,
          claim.active === false ? 0 : 1,
          // ON CONFLICT patch binds — same values again, un-defaulted.
          writeBlob,
          writeEmbedModel,
          writeDim,
          textIsNew ? 1 : 0,
          textIsNew ? 1 : 0,
          textIsNew ? 1 : 0,
          helpfulCount,
          unhelpfulCount,
          weight,
          lastUsedAt,
        );

      // Replace alternate vectors only when the caller supplied a new
      // projection. Idempotent metadata-only writes preserve the curated set.
      if (!preserveProjection && writeBlob) {
        const variants = claim.retrievalEmbeddings?.length
          ? claim.retrievalEmbeddings
          : [{ text: retrievalText, embedding: embedding! }];
        this.db.query("DELETE FROM claim_embedding WHERE claim_id = ?").run(claim.id);
        const insertVariant = this.db.query(
          `INSERT INTO claim_embedding (
             claim_id, variant, retrieval_text, embedding, embed_model, dim
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        variants.forEach((variant, index) => {
          insertVariant.run(
            claim.id,
            index,
            variant.text,
            serializeEmbedding(variant.embedding),
            claim.embedModel ?? null,
            variant.embedding.length,
          );
        });
      }
      return { id: claim.id, action: existing ? "updated" : "inserted" };
    });
    return txn.immediate();
  }

  async appendRecallLog(entry: RecallLogInput): Promise<void> {
    this.db
      .query(
        `INSERT INTO recall_log (
          query, tags_json, entities_json, kinds_json, caller_intent,
          returned_ids_json, result_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.query,
        entry.tags?.length ? JSON.stringify(entry.tags) : null,
        entry.entityRefs?.length ? JSON.stringify(entry.entityRefs) : null,
        entry.kinds?.length ? JSON.stringify(entry.kinds) : null,
        entry.callerIntent ?? null,
        JSON.stringify(entry.returnedIds),
        entry.returnedIds.length,
        entry.createdAt ?? Date.now(),
      );
  }

  /**
   * Highest-ranked active claim within `claim`'s dedup scope whose cosine meets
   * the threshold, or null. Scope is same `kind` AND same `repo` (NULL-safe) —
   * never global↔repo-specific, which would leak one repo's convention into
   * every other repo's recall or narrow knowledge that applies everywhere.
   */
  private findNearDuplicate(
    claim: ClaimInput,
    vector: Float32Array,
  ): { id: string; weight: number; createdAt: number } | null {
    const rows = this.db
      .query<
        { id: string; embedding: Uint8Array | null; weight: number | null; created_at: number },
        [ClaimKind, string | null, string]
      >(
        `SELECT id, embedding, weight, created_at FROM claim
         WHERE active = 1 AND kind = ? AND repo IS ? AND id <> ? AND embedding IS NOT NULL`,
      )
      .all(claim.kind, claim.repo ?? null, claim.id);

    const hits: Array<{ id: string; weight: number; createdAt: number }> = [];
    for (const row of rows) {
      const vec = deserializeEmbedding(row.embedding);
      if (!vec) continue;
      if (cosineSim(vector, vec) < this.dedupThreshold) continue;
      hits.push({ id: row.id, weight: row.weight ?? 1, createdAt: row.created_at });
    }
    if (hits.length === 0) return null;
    hits.sort(compareDedupWinner);
    return hits[0];
  }

  /**
   * Hybrid recall over the filtered claim corpus. Vector and exact-token ranks
   * are computed independently; explicit exact anchors activate reciprocal-rank
   * fusion while ordinary conceptual prose keeps vector ordering. This method
   * never embeds — the caller provides both the original query text and its
   * pre-computed vector at the boundary.
   */
  async recallClaims(options: ClaimRecallOptions): Promise<ClaimRecallResult[]> {
    const limit = options.limit ?? 5;
    const filters = options.filters ?? {};
    const queryVector = options.queryVector;
    const queryText = options.queryText?.trim() || null;

    // 1. SQL WHERE pre-filter — narrow candidates BEFORE any cosine.
    const where: string[] = ["active = 1"];
    const params: (string | number)[] = [];
    if (filters.repo) {
      if (filters.repoIncludeGlobal) {
        where.push("(repo = ? OR repo IS NULL)");
      } else {
        where.push("repo = ?");
      }
      params.push(filters.repo);
    }
    if (filters.kind) {
      where.push("kind = ?");
      params.push(filters.kind);
    }
    if (filters.factKind) {
      where.push("kind = 'fact'");
      where.push(
        "EXISTS (SELECT 1 FROM memory_fact AS mf WHERE mf.id = claim.id AND mf.kind = ?)",
      );
      params.push(filters.factKind);
    }
    if (filters.guidanceOnly) {
      where.push(
        `(kind IN ('lesson', 'preference', 'decision') OR (
          kind = 'fact' AND EXISTS (
            SELECT 1 FROM memory_fact AS guidance_fact
            WHERE guidance_fact.id = claim.id AND guidance_fact.kind = 'procedure'
          )
        ))`,
      );
    }
    if (filters.sinceMs != null) {
      where.push("created_at >= ?");
      params.push(filters.sinceMs);
    }
    if (filters.tags && filters.tags.length) {
      const normTags = unique(filters.tags.map(normalizeName));
      const clauses = normTags.map(
        () => "EXISTS (SELECT 1 FROM json_each(claim.tags) WHERE value = ?)",
      );
      where.push(`(${clauses.join(filters.tagMatch === "all" ? " AND " : " OR ")})`);
      params.push(...normTags);
    }
    const rows = this.db
      .query<ClaimRow, (string | number)[]>(
        `SELECT id, kind,
                (SELECT mf.kind FROM memory_fact AS mf WHERE mf.id = claim.id) AS fact_kind,
                text, retrieval_text, embedding, embed_model, dim, repo, tags, source_episode,
                substr(source_path, 1, ${MAX_CLAIM_SOURCE_PATH_CHARS}) AS source_path,
                substr(source_heading, 1, ${MAX_CLAIM_SOURCE_HEADING_CHARS}) AS source_heading,
                substr(source_text, 1, ${MAX_CLAIM_SOURCE_TEXT_CHARS}) AS source_text,
                helpful_count, unhelpful_count, weight, created_at, last_used_at, active
         FROM claim WHERE ${where.join(" AND ")}`,
      )
      .all(...params);

    const embeddingRows = this.db
      .query<
        { claim_id: string; embedding: Uint8Array },
        (string | number)[]
      >(
        `SELECT ce.claim_id, ce.embedding
         FROM claim_embedding AS ce
         INNER JOIN claim ON claim.id = ce.claim_id
         WHERE ${where.join(" AND ")} AND ce.embedding IS NOT NULL
         ORDER BY ce.claim_id, ce.variant`,
      )
      .all(...params);
    const vectorsByClaim = new Map<string, Float32Array[]>();
    for (const embeddingRow of embeddingRows) {
      const vector = deserializeEmbedding(embeddingRow.embedding);
      if (!vector) continue;
      const existing = vectorsByClaim.get(embeddingRow.claim_id);
      if (existing) existing.push(vector);
      else vectorsByClaim.set(embeddingRow.claim_id, [vector]);
    }

    // 2. Score the two retrieval channels independently. Lexical matching sees
    //    both the atomic claim and its parent section/provenance projection.
    const scored = rows.map((row) => {
      const tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
      const weight = row.weight ?? 1;
      const vectors = vectorsByClaim.get(row.id) ?? [];
      const legacyVector = deserializeEmbedding(row.embedding);
      if (vectors.length === 0 && legacyVector) vectors.push(legacyVector);
      const cosine = queryVector && vectors.length > 0
        ? Math.max(...vectors.map((vector) => cosineSim(queryVector, vector)))
        : null;
      const lexicalScore = queryText
        ? lexicalRelevance(queryText, [
            row.retrieval_text,
            row.text,
            row.source_heading,
            row.source_text,
            row.source_path,
          ])
        : null;
      return { row, tags, weight, cosine, lexicalScore, score: 0 };
    });

    const vectorRanks = new Map(
      scored
        .filter((entry) => entry.cosine !== null)
        .sort((a, b) => (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity))
        .map((entry, index) => [entry.row.id, index + 1]),
    );
    const lexicalRanks = new Map(
      scored
        .filter((entry) => (entry.lexicalScore ?? 0) > 0)
        .sort((a, b) =>
          (b.lexicalScore ?? 0) - (a.lexicalScore ?? 0) ||
          a.row.id.localeCompare(b.row.id)
        )
        .map((entry, index) => [entry.row.id, index + 1]),
    );
    for (const entry of scored) {
      if (queryVector && queryText && queryHasExactLexicalAnchor(queryText)) {
        entry.score = fusedRankScore(
          vectorRanks.get(entry.row.id) ?? null,
          lexicalRanks.get(entry.row.id) ?? null,
        );
      } else if (queryVector) {
        entry.score = entry.cosine ?? 0;
      } else if (queryText) {
        entry.score = entry.lexicalScore ?? 0;
      } else {
        entry.score = entry.weight;
      }
    }

    scored.sort((a, b) =>
      b.score - a.score ||
      (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity) ||
      (b.lexicalScore ?? -Infinity) - (a.lexicalScore ?? -Infinity) ||
      b.weight - a.weight ||
      a.row.id.localeCompare(b.row.id)
    );
    const eligible = scored.filter((entry) => {
      if (options.minCosine === undefined && options.minLexicalScore === undefined) return true;
      return (
        (options.minCosine !== undefined &&
          (entry.cosine ?? -Infinity) >= options.minCosine) ||
        (options.minLexicalScore !== undefined &&
          (entry.lexicalScore ?? 0) >= options.minLexicalScore)
      );
    });
    const results = eligible.slice(0, limit).map((entry) => ({
      id: entry.row.id,
      kind: entry.row.kind as ClaimKind,
      factKind:
        (entry.row.fact_kind as MemoryFactInput["kind"] | null | undefined) ??
        null,
      text: entry.row.text,
      repo: entry.row.repo,
      tags: entry.tags,
      weight: entry.weight,
      score: entry.score,
      cosine: entry.cosine,
      lexicalScore: entry.lexicalScore,
      sourceEpisode: entry.row.source_episode,
      sourcePath: entry.row.source_path ?? null,
      sourceHeading: entry.row.source_heading ?? null,
      sourceText: entry.row.source_text ?? null,
      helpfulCount: entry.row.helpful_count ?? 0,
      unhelpfulCount: entry.row.unhelpful_count ?? 0,
      createdAt: entry.row.created_at,
      lastUsedAt: entry.row.last_used_at,
    }));

    // Usage bump — the genuine-production-recall signal that drives decay.
    // Gated by recordUsage (default true); eval/dashboard reads pass false so
    // inspection traffic never pollutes the fade signal (§7.1).
    if (options.recordUsage !== false && results.length > 0) {
      const now = Date.now();
      const bump = this.db.query("UPDATE claim SET last_used_at = ? WHERE id = ?");
      const txn = this.db.transaction(() => {
        for (const result of results) bump.run(now, result.id);
      });
      txn();
    }

    return results;
  }

  /**
   * Export every ACTIVE claim that carries an embedding, with the Float32 LE
   * BLOB deserialized to a Float32Array (reusing the same `deserializeEmbedding`
   * helper the cosine recall path uses). Read-only; claims with no embedding are
   * skipped. Intended for the dashboard's 2D projection view, not the hot path.
   */
  async exportClaimVectors(): Promise<ClaimVectorExport[]> {
    const rows = this.db
      .query<ClaimRow, []>(
        `SELECT id, kind, text, embedding, embed_model, dim, repo, tags, source_episode,
                helpful_count, unhelpful_count, weight, created_at, last_used_at, active
         FROM claim WHERE active = 1`,
      )
      .all();
    const out: ClaimVectorExport[] = [];
    for (const row of rows) {
      const vector = deserializeEmbedding(row.embedding);
      if (!vector) continue;
      out.push({
        id: row.id,
        kind: row.kind as ClaimKind,
        text: row.text,
        repo: row.repo,
        tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
        vector,
        weight: row.weight ?? 1,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      });
    }
    return out;
  }

  // --- memory v3: episodes (raw affect log) ---------------------------------

  async appendEpisode(episode: EpisodeInput): Promise<void> {
    const txn = this.db.transaction(() => {
      // The episode extends a backing source record (provenance/evidence).
      this.db
        .query(
          `INSERT OR IGNORE INTO memory_source_record (
            id, kind, channel_id, thread_id, slack_ts, source_url, actor_id,
            actor_kind, agent_name, repo_name, body, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episode.id,
          episode.sourceKind ?? "slack_message",
          episode.channelId ?? null,
          episode.threadId ?? null,
          episode.slackTs ?? null,
          episode.sourceUrl ?? null,
          episode.actorId ?? null,
          episode.actorKind ?? null,
          episode.agentName ?? null,
          episode.repoName ?? null,
          episode.what,
          episode.metadata ? JSON.stringify(episode.metadata) : null,
          episode.createdAt,
        );
      this.db
        .query(
          `INSERT INTO episode (
            id, actor, subjects_json, what, emotion, intensity, valence,
            trigger, response, salience, consolidated_into_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            actor = excluded.actor,
            subjects_json = excluded.subjects_json,
            what = excluded.what,
            emotion = excluded.emotion,
            intensity = excluded.intensity,
            valence = excluded.valence,
            trigger = excluded.trigger,
            response = excluded.response,
            salience = excluded.salience,
            consolidated_into_json = excluded.consolidated_into_json`,
        )
        .run(
          episode.id,
          episode.actor ?? null,
          episode.subjects ? JSON.stringify(episode.subjects) : null,
          episode.what,
          episode.emotion ?? null,
          episode.intensity ?? null,
          episode.valence ?? null,
          episode.trigger ?? null,
          episode.response ?? null,
          episode.salience ?? null,
          episode.consolidatedInto ? JSON.stringify(episode.consolidatedInto) : null,
          episode.createdAt,
        );
    });
    txn();
  }

  /**
   * Bump `last_used_at` on the given episodes — the consolidation pass's record
   * that it read them (their last contribution to a derivation). Not recordUsage-
   * gated at this layer: only the genuine consolidation reader calls it.
   */
  async markEpisodesUsed(ids: string[], now: number): Promise<void> {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return;
    const bump = this.db.query("UPDATE episode SET last_used_at = ? WHERE id = ?");
    const txn = this.db.transaction(() => {
      for (const id of uniqueIds) bump.run(now, id);
    });
    txn();
  }

  /**
   * Deferred usage bump for callers that retrieve with `recordUsage: false` and
   * only later know which claims actually reached an agent's prompt (§7.1).
   */
  async markClaimsUsed(ids: string[], now: number): Promise<void> {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return;
    const bump = this.db.query("UPDATE claim SET last_used_at = ? WHERE id = ?");
    const txn = this.db.transaction(() => {
      for (const id of uniqueIds) bump.run(now, id);
    });
    txn();
  }

  /**
   * Record an explicit post-recall usefulness judgment. Feedback is additive,
   * applies to archived claims too (their provenance remains measurable), and
   * is atomic across all ids in one agent feedback call.
   */
  async recordClaimFeedback(
    ids: string[],
    useful: boolean,
  ): Promise<ClaimFeedbackResult[]> {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return [];

    const txn = this.db.transaction((): ClaimFeedbackResult[] => {
      const increment = useful ? "helpful_count" : "unhelpful_count";
      const update = this.db.query(
        `UPDATE claim
         SET ${increment} = COALESCE(${increment}, 0) + 1
         WHERE id = ?`,
      );
      for (const id of uniqueIds) update.run(id);

      const placeholders = uniqueIds.map(() => "?").join(", ");
      const rows = this.db
        .query<
          { id: string; helpful_count: number | null; unhelpful_count: number | null },
          string[]
        >(
          `SELECT id, helpful_count, unhelpful_count
           FROM claim WHERE id IN (${placeholders})`,
        )
        .all(...uniqueIds);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return uniqueIds.flatMap((id) => {
        const row = byId.get(id);
        return row
          ? [{
              id,
              helpfulCount: row.helpful_count ?? 0,
              unhelpfulCount: row.unhelpful_count ?? 0,
            }]
          : [];
      });
    });
    return txn.immediate();
  }

  async appendPreRecallObservation(observation: PreRecallObservation): Promise<void> {
    this.db.query(`INSERT INTO pre_recall_observation
      (id, thread_id, candidate_ids_json, selected_ids_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(observation.id, observation.threadId, JSON.stringify(unique(observation.candidateIds)), JSON.stringify(unique(observation.selectedIds)), observation.createdAt);
  }

  async recordPreRecallFeedback(observationId: string, useful: boolean, claimIds?: string[]): Promise<ClaimFeedbackResult[]> {
    const row = this.db.query<{ selected_ids_json: string }, [string]>("SELECT selected_ids_json FROM pre_recall_observation WHERE id = ?").get(observationId);
    if (!row) throw new Error("memory_feedback: unknown pre-recall reference");
    let selected: string[];
    try { selected = JSON.parse(row.selected_ids_json); } catch { throw new Error("memory_feedback: invalid pre-recall record"); }
    const ids = unique((claimIds?.length ? claimIds : selected).filter((id) => selected.includes(id)));
    if (ids.length === 0) throw new Error("memory_feedback: no selected claims for pre-recall reference");
    const updated = await this.recordClaimFeedback(ids, useful);
    this.db.query(`INSERT INTO pre_recall_feedback (id, observation_id, claim_ids_json, useful, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), observationId, JSON.stringify(ids), useful ? 1 : 0, Date.now());
    return updated;
  }

  async deletePreRecallObservationsOlderThan(before: number, limit: number): Promise<number> {
    const ids = this.db.query<{ id: string }, [number, number]>(
      "SELECT id FROM pre_recall_observation WHERE created_at < ? ORDER BY created_at LIMIT ?",
    ).all(before, limit).map((row) => row.id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const txn = this.db.transaction(() => {
      this.db.query(`DELETE FROM pre_recall_feedback WHERE observation_id IN (${placeholders})`).run(...ids);
      this.db.query(`DELETE FROM pre_recall_observation WHERE id IN (${placeholders})`).run(...ids);
    });
    txn.immediate();
    return ids.length;
  }

  // --- memory v3: consolidation source-record bookkeeping -------------------

  /**
   * Raw source records the consolidation engine has not yet processed
   * (`consolidated_at IS NULL`), oldest first. Scoped to one thread when
   * `threadId` is given; capped by `limit`. The offline consolidation pass
   * reads these as its input evidence.
   */
  async listUnconsolidatedSourceRecords(
    options: UnconsolidatedSourceRecordOptions = {},
  ): Promise<MemorySourceRecord[]> {
    const where: string[] = ["consolidated_at IS NULL"];
    const params: (string | number)[] = [];
    if (options.threadId) {
      where.push("thread_id = ?");
      params.push(options.threadId);
    }
    let sql = `SELECT id, kind, channel_id, thread_id, slack_ts, source_url, actor_id,
                      actor_kind, agent_name, repo_name, body, metadata_json, created_at
               FROM memory_source_record WHERE ${where.join(" AND ")}
               ORDER BY created_at ASC, id ASC`;
    if (options.limit != null) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    const rows = this.db.query<SourceRecordRow, (string | number)[]>(sql).all(...params);
    return rows.map(rowToSourceRecord);
  }

  /**
   * Stamp `consolidated_at = now` on the given source records so a later pass
   * does not reprocess them (even when they yielded no derivation — they are
   * still consumed exactly once).
   */
  async markSourceRecordsConsolidated(ids: string[], now: number): Promise<void> {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return;
    const mark = this.db.query("UPDATE memory_source_record SET consolidated_at = ? WHERE id = ?");
    const txn = this.db.transaction(() => {
      for (const id of uniqueIds) mark.run(now, id);
    });
    txn();
  }

  // --- memory v3: decay / forgetting (§7.1) ---------------------------------

  /**
   * ARCHIVE (set `active = 0`, never DELETE — keep provenance) every active claim
   * that is BOTH stale AND low-value. Stale = `last_used_at` older than the cutoff,
   * or never used and `created_at` older than the cutoff. Low-value = `weight <=
   * maxWeight`. Forget by value AND age — age alone never forgets. Batch/offline.
   */
  async archiveStaleClaims(options: ArchiveStaleClaimsOptions): Promise<ArchiveStaleClaimsResult> {
    const now = options.now ?? Date.now();
    const cutoff = now - options.olderThanMs;
    const rows = this.db
      .query<{ id: string }, [number, number, number]>(
        `SELECT id FROM claim
         WHERE active = 1
           AND weight <= ?
           AND ((last_used_at IS NOT NULL AND last_used_at < ?)
                OR (last_used_at IS NULL AND created_at < ?))`,
      )
      .all(options.maxWeight, cutoff, cutoff);
    const candidateIds = rows.map((row) => row.id);
    const apply = options.apply === true;
    const archivedIds = apply ? candidateIds : [];
    if (apply && archivedIds.length > 0) {
      const archive = this.db.query("UPDATE claim SET active = 0 WHERE id = ?");
      const txn = this.db.transaction(() => {
        for (const id of archivedIds) archive.run(id);
      });
      txn();
    }
    return { candidateIds, archivedIds, applied: apply };
  }

  /**
   * Fold a cluster of near-duplicates into one survivor (the offline backfill
   * sweep's write primitive): sum the duplicates' counters into the survivor,
   * inherit their newest `last_used_at`, then ARCHIVE them (`active = 0`, never
   * delete — the collapsed rows stay as provenance).
   *
   * Deliberately does NOT refresh `last_used_at` to "now" the way the hot-path
   * merge does. A backfill is not a rediscovery; stamping the whole corpus fresh
   * would make everything look recently used and gut the fade signal. Taking the
   * cluster MAX preserves the most recent genuine use without inventing one.
   */
  async collapseDuplicateClaims(
    options: CollapseDuplicateClaimsOptions,
  ): Promise<CollapseDuplicateClaimsResult> {
    const duplicateIds = unique(options.duplicateIds).filter((id) => id !== options.survivorId);
    if (duplicateIds.length === 0) return { archivedIds: [] };

    // IMMEDIATE for the same reason as `upsertClaim`: this transaction reads the
    // survivor and the cluster before it writes, and a DEFERRED read-then-write
    // txn under WAL dies with the non-retryable SQLITE_BUSY_SNAPSHOT if another
    // writer commits inside the read window. Every other transaction in this file
    // opens with a write, where DEFERRED already takes the write lock on its
    // first statement.
    const txn = this.db.transaction((): string[] => {
      const survivor = this.db
        .query<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM claim WHERE id = ?",
        )
        .get(options.survivorId);
      if (!survivor) {
        throw new Error(`collapseDuplicateClaims: survivor "${options.survivorId}" not found`);
      }

      const placeholders = duplicateIds.map(() => "?").join(", ");
      const rows = this.db
        .query<
          { id: string; helpful_count: number | null; unhelpful_count: number | null; last_used_at: number | null },
          string[]
        >(
          `SELECT id, helpful_count, unhelpful_count, last_used_at FROM claim
           WHERE active = 1 AND id IN (${placeholders})`,
        )
        .all(...duplicateIds);
      if (rows.length === 0) return [];

      let helpful = 0;
      let unhelpful = 0;
      let newestUse = survivor.last_used_at;
      for (const row of rows) {
        helpful += row.helpful_count ?? 0;
        unhelpful += row.unhelpful_count ?? 0;
        if (row.last_used_at != null && (newestUse == null || row.last_used_at > newestUse)) {
          newestUse = row.last_used_at;
        }
      }

      this.db
        .query(
          `UPDATE claim
           SET helpful_count = COALESCE(helpful_count, 0) + ?,
               unhelpful_count = COALESCE(unhelpful_count, 0) + ?,
               last_used_at = ?
           WHERE id = ?`,
        )
        .run(helpful, unhelpful, newestUse, options.survivorId);

      const archive = this.db.query("UPDATE claim SET active = 0 WHERE id = ?");
      const archivedIds = rows.map((row) => row.id);
      for (const id of archivedIds) archive.run(id);
      return archivedIds;
    });

    return { archivedIds: txn.immediate() };
  }

  /**
   * Read-only decay summary — per claim kind plus the episode log: corpus size,
   * how many have never been used, the oldest `last_used_at`, and the current
   * fade-candidate count under the supplied (or default) cutoff/ceiling, plus
   * the near-duplicate rate — the standing metric for the write guard, without
   * which the next dedup regression is as invisible as the last one. Never
   * writes; safe for dashboards.
   */
  async memoryHealth(options: MemoryHealthOptions = {}): Promise<MemoryHealth> {
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? 90 * 24 * 60 * 60 * 1000;
    const maxWeight = options.maxWeight ?? 0.5;
    const cutoff = now - olderThanMs;
    const dedupThreshold = options.dedupThreshold ?? this.dedupThreshold;
    const nearDuplicateStats =
      options.includeNearDuplicates === false
        ? null
        : this.countNearDuplicatesByKind(dedupThreshold);

    const kinds: MemoryHealthKind[] = [];

    const claimKinds: ClaimKind[] = [
      "lesson",
      "fact",
      "preference",
      "decision",
      "situation-claim",
    ];
    for (const kind of claimKinds) {
      const summary = this.db
        .query<
          { total: number; never_used: number; oldest: number | null },
          [string]
        >(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END) AS never_used,
                  MIN(last_used_at) AS oldest
           FROM claim WHERE active = 1 AND kind = ?`,
        )
        .get(kind);
      const fade = this.db
        .query<{ n: number }, [string, number, number, number]>(
          `SELECT COUNT(*) AS n FROM claim
           WHERE active = 1
             AND kind = ?
             AND weight <= ?
             AND ((last_used_at IS NOT NULL AND last_used_at < ?)
                  OR (last_used_at IS NULL AND created_at < ?))`,
        )
        .get(kind, maxWeight, cutoff, cutoff);
      const total = summary?.total ?? 0;
      const neverUsed = summary?.never_used ?? 0;
      const nearDuplicates = nearDuplicateStats?.twinned.get(kind) ?? 0;
      // Denominator is the EMBEDDED active claims of this kind, not `total`. Only
      // vector-carrying rows can be counted as twins, so measuring them against a
      // corpus that still holds vector-less legacy rows understates the rate.
      const embedded = nearDuplicateStats?.embedded.get(kind) ?? 0;
      kinds.push({
        kind,
        total,
        neverUsed,
        pctNeverUsed: total > 0 ? neverUsed / total : 0,
        oldestLastUsedAt: summary?.oldest ?? null,
        fadeCandidates: fade?.n ?? 0,
        nearDuplicates: nearDuplicateStats ? nearDuplicates : null,
        nearDuplicateRate: nearDuplicateStats
          ? embedded > 0
            ? nearDuplicates / embedded
            : 0
          : null,
      });
    }

    const episodeSummary = this.db
      .query<{ total: number; never_used: number; oldest: number | null }, []>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END) AS never_used,
                MIN(last_used_at) AS oldest
         FROM episode`,
      )
      .get();
    const episodeTotal = episodeSummary?.total ?? 0;
    const episodeNeverUsed = episodeSummary?.never_used ?? 0;
    kinds.push({
      kind: "episode",
      total: episodeTotal,
      neverUsed: episodeNeverUsed,
      pctNeverUsed: episodeTotal > 0 ? episodeNeverUsed / episodeTotal : 0,
      oldestLastUsedAt: episodeSummary?.oldest ?? null,
      fadeCandidates: 0, // episodes are never value-archived.
      nearDuplicates: null, // episodes are not embedded; dedup does not apply.
      nearDuplicateRate: null,
    });

    return { generatedAt: now, olderThanMs, maxWeight, dedupThreshold, kinds };
  }

  /**
   * Per-kind count of active claims that have at least one twin at/above the
   * threshold INSIDE their own dedup scope (same kind, same repo), alongside the
   * per-kind count of claims that were eligible to be counted at all (i.e. carry
   * a vector) — the rate's denominator, so it is not diluted by vector-less
   * legacy rows that no cosine can ever match.
   *
   * All-pairs within each scope — O(n²) cosine, seconds at a few thousand claims.
   * That is the price of the standing metric; `includeNearDuplicates: false`
   * opts a latency-sensitive caller out. Scoping is not an optimization: the
   * sweep ARCHIVES duplicates rather than deleting them, so a corpus-wide count
   * would keep reporting the rows it just collapsed.
   *
   * WARNING to whoever wires `memoryHealth` into the HTTP dashboard or any other
   * request path: this loop is SYNCHRONOUS and blocks the event loop for its full
   * duration (measured 1464ms at 2600 claims, growing quadratically). It has no
   * production caller today. Either pass `includeNearDuplicates: false` on the
   * request path and compute the rate on a schedule, or move this off the hot
   * path before exposing it.
   */
  private countNearDuplicatesByKind(threshold: number): {
    twinned: Map<string, number>;
    embedded: Map<string, number>;
  } {
    const rows = this.db
      .query<{ id: string; kind: string; repo: string | null; embedding: Uint8Array | null }, []>(
        "SELECT id, kind, repo, embedding FROM claim WHERE active = 1 AND embedding IS NOT NULL",
      )
      .all();

    const scopes = new Map<string, Array<{ kind: string; vec: Float32Array }>>();
    const embedded = new Map<string, number>();
    for (const row of rows) {
      const vec = deserializeEmbedding(row.embedding);
      if (!vec) continue;
      embedded.set(row.kind, (embedded.get(row.kind) ?? 0) + 1);
      const key = dedupScopeKey(row.kind, row.repo);
      const bucket = scopes.get(key);
      if (bucket) bucket.push({ kind: row.kind, vec });
      else scopes.set(key, [{ kind: row.kind, vec }]);
    }

    const counts = new Map<string, number>();
    for (const members of scopes.values()) {
      const twinned = new Array<boolean>(members.length).fill(false);
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          // Both ends of a qualifying pair count as near-duplicates.
          if (twinned[i] && twinned[j]) continue;
          if (cosineSim(members[i].vec, members[j].vec) < threshold) continue;
          twinned[i] = true;
          twinned[j] = true;
        }
      }
      for (let i = 0; i < members.length; i += 1) {
        if (!twinned[i]) continue;
        counts.set(members[i].kind, (counts.get(members[i].kind) ?? 0) + 1);
      }
    }
    return { twinned: counts, embedded };
  }

  private upsertNode(id: string, kind: string, createdAt: number): void {
    this.db
      .query(
        `INSERT INTO memory_node (id, kind, created_at, valid_at, invalid_at, superseded_by)
         VALUES (?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind`,
      )
      .run(id, kind, createdAt, createdAt);
  }

  private replaceProvenance(memoryId: string, sourceIds: string[]): void {
    this.db.query("DELETE FROM memory_provenance WHERE memory_id = ?").run(memoryId);
    const insert = this.db.query(
      "INSERT OR IGNORE INTO memory_provenance (memory_id, source_id) VALUES (?, ?)",
    );
    for (const sourceId of sourceIds) insert.run(memoryId, sourceId);
  }

  private replaceTags(memoryId: string, memoryKind: string, tags: string[]): void {
    this.db.query("DELETE FROM memory_tag WHERE memory_id = ?").run(memoryId);
    for (const tagName of unique(tags.map(normalizeName))) {
      const tagId = `tag:${tagName}`;
      this.upsertNode(tagId, "tag", Date.now());
      this.db
        .query("INSERT OR IGNORE INTO tag (id, name) VALUES (?, ?)")
        .run(tagId, tagName);
      this.db
        .query("INSERT OR IGNORE INTO memory_tag (memory_id, tag_id, memory_kind) VALUES (?, ?, ?)")
        .run(memoryId, tagId, memoryKind);
    }
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (!cols.includes(column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  /**
   * Widen the memory_node.kind CHECK to allow 'claim' on DBs created before v3.
   * SQLite can't ALTER a CHECK, and CREATE TABLE IF NOT EXISTS won't retrofit
   * one, so an old node table would reject the memory_node row that upsertClaim
   * writes. Rebuild the table (it has no extra indexes/triggers; FK enforcement
   * is off) only when the current CHECK lacks 'claim' — idempotent thereafter.
   */
  private ensureMemoryNodeAllowsClaim(): void {
    const row = this.db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_node'",
      )
      .get();
    if (!row || row.sql.includes("'claim'")) return;
    this.db.transaction(() => {
      this.db.run(
        `CREATE TABLE memory_node_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory', 'entity', 'tag', 'claim')), created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT)`,
      );
      this.db.run(
        "INSERT INTO memory_node_new (id, kind, created_at, valid_at, invalid_at, superseded_by) SELECT id, kind, created_at, valid_at, invalid_at, superseded_by FROM memory_node",
      );
      this.db.run("DROP TABLE memory_node");
      this.db.run("ALTER TABLE memory_node_new RENAME TO memory_node");
    })();
  }

  /** Retrofit the claim kind CHECK when the semantic taxonomy grows. */
  private ensureClaimAllowsAllKinds(): void {
    const row = this.db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='claim'",
      )
      .get();
    if (!row || ["'preference'", "'decision'"].every((kind) => row.sql.includes(kind))) {
      return;
    }
    this.db.transaction(() => {
      this.db.run(`CREATE TABLE claim_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('lesson', 'fact', 'preference', 'decision', 'situation-claim')),
        text TEXT NOT NULL, retrieval_text TEXT, embedding BLOB, embed_model TEXT,
        dim INTEGER, repo TEXT, tags TEXT, source_episode TEXT,
        source_path TEXT, source_heading TEXT, source_text TEXT,
        helpful_count INTEGER DEFAULT 0, unhelpful_count INTEGER DEFAULT 0,
        weight REAL DEFAULT 1.0, created_at INTEGER, last_used_at INTEGER,
        active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id)
      )`);
      this.db.run(`INSERT INTO claim_new (
        id, kind, text, retrieval_text, embedding, embed_model, dim, repo, tags,
        source_episode, source_path, source_heading, source_text,
        helpful_count, unhelpful_count, weight, created_at,
        last_used_at, active
      ) SELECT id, kind, text, retrieval_text, embedding, embed_model, dim, repo,
               tags, source_episode, source_path, source_heading, source_text,
               helpful_count, unhelpful_count, weight,
               created_at, last_used_at, active FROM claim`);
      this.db.run("DROP TABLE claim");
      this.db.run("ALTER TABLE claim_new RENAME TO claim");
    })();
  }

  private migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_source_record (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('slack_message', 'runner_output', 'routing_decision', 'routing_correction', 'ingestion_correction', 'curated_fact', 'manual_correction')), channel_id TEXT, thread_id TEXT, slack_ts TEXT, source_url TEXT, actor_id TEXT, actor_kind TEXT CHECK (actor_kind IN ('human', 'junior', 'agent', 'bot', 'system')), agent_name TEXT, repo_name TEXT, body TEXT NOT NULL, metadata_json TEXT, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_node (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory', 'entity', 'tag', 'claim')), created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS lesson (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, applies_when TEXT, importance REAL DEFAULT 0.5, created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_fact (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('curated_fact', 'routing_memory', 'procedure')), title TEXT, body TEXT NOT NULL, confidence REAL DEFAULT 0.5, importance REAL DEFAULT 0.5, created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS entity (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS tag (id TEXT PRIMARY KEY, name TEXT NOT NULL, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_tag (memory_id TEXT NOT NULL, tag_id TEXT NOT NULL, memory_kind TEXT NOT NULL CHECK (memory_kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory')), PRIMARY KEY (memory_id, tag_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_provenance (memory_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (memory_id, source_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS ingestion_classification (event_id TEXT NOT NULL, input_text TEXT NOT NULL, extracted_mentions_json TEXT NOT NULL, assigned_tags_json TEXT NOT NULL, assigned_event_types_json TEXT NOT NULL, created_edges_json TEXT NOT NULL, extractor TEXT NOT NULL, confidence REAL NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (event_id, extractor, created_at))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS ingestion_correction (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, field TEXT NOT NULL, incorrect_value TEXT, correct_value TEXT, corrected_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS consolidation_decision (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, source_ids_json TEXT NOT NULL, extractor TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS recall_log (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT, tags_json TEXT, entities_json TEXT, kinds_json TEXT, caller_intent TEXT, returned_ids_json TEXT NOT NULL, result_count INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS pre_recall_observation (id TEXT PRIMARY KEY, thread_id TEXT, candidate_ids_json TEXT NOT NULL, selected_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS pre_recall_feedback (id TEXT PRIMARY KEY, observation_id TEXT NOT NULL, claim_ids_json TEXT NOT NULL, useful INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY (observation_id) REFERENCES pre_recall_observation(id))`);
    // memory v3: semantic claim store (text + embedding co-located) — mirrors the lesson/memory_node relationship.
    this.db.run(`CREATE TABLE IF NOT EXISTS claim (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('lesson', 'fact', 'preference', 'decision', 'situation-claim')), text TEXT NOT NULL, retrieval_text TEXT, embedding BLOB, embed_model TEXT, dim INTEGER, repo TEXT, tags TEXT, source_episode TEXT, source_path TEXT, source_heading TEXT, source_text TEXT, helpful_count INTEGER DEFAULT 0, unhelpful_count INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, created_at INTEGER, last_used_at INTEGER, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS claim_embedding (claim_id TEXT NOT NULL, variant INTEGER NOT NULL, retrieval_text TEXT NOT NULL, embedding BLOB NOT NULL, embed_model TEXT, dim INTEGER NOT NULL, PRIMARY KEY (claim_id, variant), FOREIGN KEY (claim_id) REFERENCES claim(id))`);
    this.db.run(`INSERT OR IGNORE INTO claim_embedding (claim_id, variant, retrieval_text, embedding, embed_model, dim) SELECT id, 0, COALESCE(retrieval_text, text), embedding, embed_model, dim FROM claim WHERE embedding IS NOT NULL AND dim IS NOT NULL`);
    this.ensureColumn("claim", "retrieval_text", "TEXT");
    this.ensureColumn("claim", "source_path", "TEXT");
    this.ensureColumn("claim", "source_heading", "TEXT");
    this.ensureColumn("claim", "source_text", "TEXT");
    this.ensureClaimAllowsAllKinds();
    // memory v3: raw episodic log (affect sidecar over memory_source_record).
    this.db.run(`CREATE TABLE IF NOT EXISTS episode (id TEXT PRIMARY KEY, actor TEXT, subjects_json TEXT, what TEXT, emotion TEXT, intensity REAL, valence REAL, trigger TEXT, response TEXT, salience REAL, consolidated_into_json TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, FOREIGN KEY (id) REFERENCES memory_source_record(id))`);
    this.ensureColumn("episode", "last_used_at", "INTEGER");
    // memory v3: consolidation bookkeeping — which raw source records have been
    // folded into a derivation (idempotent ALTER for DBs created before this).
    this.ensureColumn("memory_source_record", "consolidated_at", "INTEGER");
    // memory v3: retrofit the memory_node.kind CHECK to allow 'claim' on old DBs.
    this.ensureMemoryNodeAllowsClaim();
    this.db.run("CREATE INDEX IF NOT EXISTS memory_tag_tag_idx ON memory_tag(tag_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS recall_log_created_idx ON recall_log(created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_repo_idx ON claim(repo)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_kind_idx ON claim(kind)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_active_created_idx ON claim(active, created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_embedding_claim_idx ON claim_embedding(claim_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS episode_created_idx ON episode(created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS source_record_unconsolidated_idx ON memory_source_record(consolidated_at, created_at)");
  }
}

function validateSourceField(
  name: string,
  value: string | null | undefined,
  maxChars: number,
): void {
  if (value !== undefined && value !== null && value.length > maxChars) {
    throw new Error(`upsertClaim: ${name} exceeds ${maxChars} characters`);
  }
}

/** Map a raw `memory_source_record` row to the public `MemorySourceRecord`. */
function rowToSourceRecord(row: SourceRecordRow): MemorySourceRecord {
  return {
    id: row.id,
    kind: row.kind as MemorySourceRecord["kind"],
    channelId: row.channel_id,
    threadId: row.thread_id,
    slackTs: row.slack_ts,
    sourceUrl: row.source_url,
    actorId: row.actor_id,
    actorKind: row.actor_kind as MemorySourceRecord["actorKind"],
    agentName: row.agent_name,
    repoName: row.repo_name,
    body: row.body,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}

/**
 * Serialize a Float32Array to a little-endian BLOB (Buffer) for SQLite.
 * Exported so every embedding-bearing table in this DB (claims, task routes)
 * shares ONE definition of the BLOB layout rather than two that can drift.
 */
export function serializeEmbedding(vec: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i += 1) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** Deserialize a little-endian BLOB back into a Float32Array. */
export function deserializeEmbedding(blob: Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const out = new Float32Array(Math.floor(buf.byteLength / 4));
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Cosine similarity. Returns 0 for mismatched dims or a zero vector. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}
