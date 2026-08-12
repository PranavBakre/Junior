import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  deserializeEmbedding,
  serializeEmbedding,
} from "../memory/sqlite.ts";
import {
  ReloadingSlackArchiveVectorIndex,
  SlackArchiveVectorIndex,
  type SlackArchiveMutableVectorIndex,
  type SlackArchiveVectorRecord,
  type SlackArchiveVectorSearcher,
} from "./archive-vector-index.ts";
import type {
  SlackArchiveCheckpoint,
  SlackArchiveCheckpointInput,
  SlackArchiveConversation,
  SlackArchiveFilters,
  SlackArchiveMessage,
  SlackArchiveMessageInput,
  SlackArchiveSearchOptions,
  SlackArchiveSearchResult,
  SlackArchiveWriteResult,
} from "./archive-types.ts";

const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const DEFAULT_THREAD_LIMIT = 100;
const MAX_THREAD_LIMIT = 500;
const MAX_RETRIEVAL_CANDIDATES = 2_000;
const DEFAULT_VECTOR_DIMENSIONS = 640;
const BUSY_TIMEOUT_MS = 5_000;
const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_BASE_DELAY_MS = 25;
const FTS_ROWID_MIGRATION = "fts-rowid-v1";
const EMBEDDING_CORPUS_REVISION = "embedding-corpus-revision";
const EMBEDDING_INDEX_REVISION_PREFIX = "embedding-index-revision:";

export interface SlackArchiveEmbeddingCandidate {
  channelId: string;
  ts: string;
  text: string;
}

export interface SlackArchiveEmbeddingUpdate extends SlackArchiveEmbeddingCandidate {
  embedding: Float32Array;
  embedModel: string;
  dim: number;
}

type ArchiveRow = {
  channel_id: string;
  channel_name: string | null;
  ts: string;
  thread_ts: string;
  actor_id: string | null;
  user_id: string | null;
  bot_id: string | null;
  actor_name: string | null;
  actor_kind: string | null;
  text: string;
  files_json: string | null;
  subtype: string | null;
  permalink: string | null;
  metadata_json: string | null;
  raw_json: string | null;
  embedding: Uint8Array | null;
  embed_model: string | null;
  dim: number | null;
  ingest_source: string;
  observed_at: number;
  event_time_ms: number;
};

/**
 * Passive Slack history, isolated from memory_source_record and the durable
 * claim system. The canonical identity is Slack's channel + message timestamp.
 */
export class SlackArchiveStore {
  private db: Database;
  private readonly vectorIndex: SlackArchiveVectorSearcher;
  private readonly mutableVectorIndex: SlackArchiveMutableVectorIndex | null;

  constructor(dbPath: string, options: {
    readonly?: boolean;
    vectorDimensions?: number;
    vectorIndex?: SlackArchiveVectorSearcher;
    vectorIndexPath?: string;
  } = {}) {
    if (!options.readonly) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = options.readonly
      ? new Database(dbPath, { readonly: true })
      : new Database(dbPath);
    this.db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const vectorDimensions = options.vectorDimensions ?? DEFAULT_VECTOR_DIMENSIONS;
    if (options.vectorIndex) {
      this.vectorIndex = options.vectorIndex;
      this.mutableVectorIndex = isMutableVectorIndex(options.vectorIndex)
        ? options.vectorIndex
        : null;
    } else if (dbPath === ":memory:") {
      const index = new SlackArchiveVectorIndex(vectorDimensions);
      this.vectorIndex = index;
      this.mutableVectorIndex = index;
    } else {
      this.vectorIndex = new ReloadingSlackArchiveVectorIndex(
        options.vectorIndexPath ?? `${dbPath}.usearch`,
        vectorDimensions,
      );
      this.mutableVectorIndex = null;
    }
    if (options.readonly) return;
    retrySqliteBusy(() => {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = NORMAL");
      this.db.run(`
        CREATE TABLE IF NOT EXISTS slack_archive_message (
          channel_id TEXT NOT NULL,
          channel_name TEXT,
          ts TEXT NOT NULL,
          thread_ts TEXT NOT NULL,
          actor_id TEXT,
          user_id TEXT,
          bot_id TEXT,
          actor_name TEXT,
          actor_kind TEXT,
          text TEXT NOT NULL,
          files_json TEXT,
          subtype TEXT,
          permalink TEXT,
          metadata_json TEXT,
          raw_json TEXT,
          embedding BLOB,
          embed_model TEXT,
          dim INTEGER,
          ingest_source TEXT NOT NULL CHECK (ingest_source IN ('live', 'backfill')),
          observed_at INTEGER NOT NULL,
          event_time_ms INTEGER NOT NULL,
          PRIMARY KEY (channel_id, ts)
        )
      `);
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_slack_archive_thread ON slack_archive_message(channel_id, thread_ts, event_time_ms, ts)",
      );
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_slack_archive_actor_time ON slack_archive_message(actor_id, event_time_ms)",
      );
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_slack_archive_channel_time ON slack_archive_message(channel_id, event_time_ms)",
      );
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_slack_archive_pending_embedding
        ON slack_archive_message(channel_id, ts)
        WHERE embedding IS NULL
          AND length(trim(text, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0
      `);
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS slack_archive_fts USING fts5(
          channel_id UNINDEXED,
          ts UNINDEXED,
          text,
          actor_name,
          channel_name,
          tokenize = 'unicode61'
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS slack_archive_conversation (
          id TEXT PRIMARY KEY,
          name TEXT,
          kind TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS slack_archive_checkpoint (
          scope TEXT PRIMARY KEY,
          cursor TEXT NOT NULL,
          metadata_json TEXT,
          updated_at INTEGER NOT NULL
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS slack_archive_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      migrateFtsRowids(this.db);
    });
  }

  close(): void {
    this.db.close();
  }

  upsertMessage(input: SlackArchiveMessageInput): SlackArchiveWriteResult {
    validateMessage(input);
    const transaction = this.db.transaction(() => this.writeMessage(input));
    return retrySqliteBusy(() => transaction());
  }

  private writeMessage(input: SlackArchiveMessageInput): SlackArchiveWriteResult {
    const observedAt = input.observedAt ?? Date.now();
    const existing = this.db
      .query<{
        observed_at: number;
        ingest_source: string;
        text: string;
        embedding: Uint8Array | null;
      }, [string, string]>(
        "SELECT observed_at, ingest_source, text, embedding FROM slack_archive_message WHERE channel_id = ? AND ts = ?",
      )
      .get(input.channelId, input.ts);
    const ingestSource = input.ingestSource ?? "backfill";
    if (
      existing &&
      (existing.observed_at > observedAt ||
        (existing.ingest_source === "live" && ingestSource === "backfill") ||
        (existing.ingest_source === "backfill" &&
          ingestSource === "backfill" &&
          existing.observed_at === observedAt))
    ) return "deduped";

    const eventTimeMs = input.eventTimeMs ?? slackTsToMs(input.ts);
    const embedding = input.embedding ?? null;
    const blob = embedding ? serializeEmbedding(embedding) : null;
    this.db.query(`
      INSERT INTO slack_archive_message (
        channel_id, channel_name, ts, thread_ts, actor_id, user_id, bot_id, actor_name, actor_kind,
        text, files_json, subtype, permalink, metadata_json, raw_json, embedding, embed_model, dim,
        ingest_source, observed_at, event_time_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, ts) DO UPDATE SET
        channel_name = excluded.channel_name,
        thread_ts = excluded.thread_ts,
        actor_id = excluded.actor_id,
        user_id = excluded.user_id,
        bot_id = excluded.bot_id,
        actor_name = excluded.actor_name,
        actor_kind = excluded.actor_kind,
        text = excluded.text,
        files_json = excluded.files_json,
        subtype = excluded.subtype,
        permalink = excluded.permalink,
        metadata_json = excluded.metadata_json,
        raw_json = excluded.raw_json,
        embedding = CASE
          WHEN excluded.embedding IS NOT NULL THEN excluded.embedding
          WHEN excluded.text = slack_archive_message.text THEN slack_archive_message.embedding
          ELSE NULL END,
        embed_model = CASE
          WHEN excluded.embedding IS NOT NULL THEN excluded.embed_model
          WHEN excluded.text = slack_archive_message.text THEN slack_archive_message.embed_model
          ELSE NULL END,
        dim = CASE
          WHEN excluded.embedding IS NOT NULL THEN excluded.dim
          WHEN excluded.text = slack_archive_message.text THEN slack_archive_message.dim
          ELSE NULL END,
        ingest_source = excluded.ingest_source,
        observed_at = excluded.observed_at,
        event_time_ms = excluded.event_time_ms
    `).run(
      input.channelId,
      input.channelName ?? null,
      input.ts,
      input.threadTs ?? input.ts,
      input.actorId ?? input.userId ?? input.botId ?? null,
      input.userId ?? null,
      input.botId ?? null,
      input.actorName ?? null,
      input.actorKind ?? null,
      input.text,
      input.files?.length ? JSON.stringify(input.files) : null,
      input.subtype ?? null,
      input.permalink ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.rawJson ? JSON.stringify(input.rawJson) : null,
      blob,
      embedding ? (input.embedModel ?? null) : null,
      embedding ? (input.dim ?? embedding.length) : null,
      ingestSource,
      observedAt,
      eventTimeMs,
    );
    const messageRow = this.db
      .query<{ rowid: number }, [string, string]>(
        "SELECT rowid FROM slack_archive_message WHERE channel_id = ? AND ts = ?",
      )
      .get(input.channelId, input.ts);
    if (!messageRow) throw new Error("Slack archive message disappeared during FTS update");
    this.db
      .query("DELETE FROM slack_archive_fts WHERE rowid = ?")
      .run(messageRow.rowid);
    this.db.query(`
      INSERT INTO slack_archive_fts(rowid, channel_id, ts, text, actor_name, channel_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      messageRow.rowid,
      input.channelId,
      input.ts,
      input.text,
      input.actorName ?? "",
      input.channelName ?? "",
    );
    const storedEmbedding = this.db.query<
      { embedding: Uint8Array | null },
      [number]
    >("SELECT embedding FROM slack_archive_message WHERE rowid = ?").get(messageRow.rowid)?.embedding;
    if (storedEmbedding) {
      this.mutableVectorIndex?.upsert({
        rowid: messageRow.rowid,
        embedding: deserializeEmbedding(storedEmbedding)!,
      });
    } else {
      this.mutableVectorIndex?.remove(messageRow.rowid);
    }
    if (
      (!existing && storedEmbedding) ||
      (existing?.embedding && !storedEmbedding) ||
      input.embedding != null
    ) {
      this.bumpEmbeddingCorpusRevision();
    }
    return existing ? "updated" : "inserted";
  }

  upsertMessages(inputs: SlackArchiveMessageInput[]): SlackArchiveWriteResult[] {
    if (inputs.length === 0) return [];
    inputs.forEach(validateMessage);
    const transaction = this.db.transaction((rows: SlackArchiveMessageInput[]) =>
      rows.map((row) => this.writeMessage(row))
    );
    return retrySqliteBusy(() => transaction(inputs));
  }

  getMessage(channelId: string, ts: string): SlackArchiveMessage | null {
    const row = this.db
      .query<ArchiveRow, [string, string]>(
        "SELECT * FROM slack_archive_message WHERE channel_id = ? AND ts = ?",
      )
      .get(channelId, ts);
    return row ? rowToMessage(row) : null;
  }

  listChannelIds(): string[] {
    return this.db
      .query<{ channel_id: string }, []>(
        "SELECT DISTINCT channel_id FROM slack_archive_message ORDER BY channel_id",
      )
      .all()
      .map((row) => row.channel_id);
  }

  getThreadSyncState(
    channelId: string,
  ): Map<string, { latestTs: string; hasRoot: boolean }> {
    const rows = this.db
      .query<{ thread_ts: string; latest_ts: string; has_root: number }, [string]>(`
        SELECT thread_ts, max(ts) AS latest_ts,
               max(CASE WHEN ts = thread_ts THEN 1 ELSE 0 END) AS has_root
        FROM slack_archive_message
        WHERE channel_id = ?
        GROUP BY thread_ts
      `)
      .all(channelId);
    return new Map(rows.map((row) => [row.thread_ts, {
      latestTs: row.latest_ts,
      hasRoot: row.has_root === 1,
    }]));
  }

  countMessagesPendingEmbedding(): { pending: number; emptyText: number } {
    const row = this.db.query<{ pending: number; empty_text: number }, []>(`
      SELECT
        SUM(CASE WHEN length(trim(text, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN length(trim(text, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) = 0 THEN 1 ELSE 0 END) AS empty_text
      FROM slack_archive_message
      WHERE embedding IS NULL
    `).get();
    return { pending: row?.pending ?? 0, emptyText: row?.empty_text ?? 0 };
  }

  getMessagesPendingEmbedding(limit: number): SlackArchiveEmbeddingCandidate[] {
    const bounded = boundedLimit(limit, 100, 10_000);
    return this.db.query<
      { channel_id: string; ts: string; text: string },
      [number]
    >(`
      SELECT channel_id, ts, text
      FROM slack_archive_message
      WHERE embedding IS NULL
        AND length(trim(text, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0
      ORDER BY channel_id ASC, ts ASC
      LIMIT ?
    `).all(bounded).map((row) => ({
      channelId: row.channel_id,
      ts: row.ts,
      text: row.text,
    }));
  }

  countEmbeddedMessages(dim: number): number {
    return this.db.query<{ count: number }, [number]>(`
      SELECT count(*) AS count
      FROM slack_archive_message
      WHERE embedding IS NOT NULL AND dim = ?
    `).get(dim)?.count ?? 0;
  }

  getEmbeddedVectorRecords(
    afterRowid: number,
    limit: number,
    dim: number,
  ): SlackArchiveVectorRecord[] {
    return this.db.query<
      { rowid: number; embedding: Uint8Array },
      [number, number, number]
    >(`
      SELECT rowid, embedding
      FROM slack_archive_message
      WHERE rowid > ? AND embedding IS NOT NULL AND dim = ?
      ORDER BY rowid ASC
      LIMIT ?
    `).all(afterRowid, dim, boundedLimit(limit, 1_000, 10_000)).map((row) => ({
      rowid: row.rowid,
      embedding: deserializeEmbedding(row.embedding)!,
    }));
  }

  updateMessageEmbeddings(updates: SlackArchiveEmbeddingUpdate[]): number {
    if (updates.length === 0) return 0;
    for (const update of updates) {
      if (update.embedding.length !== update.dim) {
        throw new Error("Slack archive embedding length does not match dim");
      }
    }
    const statement = this.db.query(`
      UPDATE slack_archive_message
      SET embedding = ?, embed_model = ?, dim = ?
      WHERE channel_id = ? AND ts = ? AND text = ? AND embedding IS NULL
    `);
    const rowidStatement = this.db.query<
      { rowid: number },
      [string, string]
    >("SELECT rowid FROM slack_archive_message WHERE channel_id = ? AND ts = ?");
    const indexed: SlackArchiveVectorRecord[] = [];
    const transaction = this.db.transaction((rows: SlackArchiveEmbeddingUpdate[]) => {
      let updated = 0;
      for (const row of rows) {
        const result = statement.run(
          serializeEmbedding(row.embedding),
          row.embedModel,
          row.dim,
          row.channelId,
          row.ts,
          row.text,
        );
        updated += result.changes;
        if (result.changes > 0 && this.mutableVectorIndex) {
          const stored = rowidStatement.get(row.channelId, row.ts);
          if (stored) indexed.push({ rowid: stored.rowid, embedding: row.embedding });
        }
      }
      return updated;
    });
    const updated = retrySqliteBusy(() => transaction(updates));
    if (updated > 0) this.bumpEmbeddingCorpusRevision();
    for (const record of indexed) this.mutableVectorIndex?.upsert(record);
    return updated;
  }

  getEmbeddingCorpusRevision(): number {
    return this.getMetadataInteger(EMBEDDING_CORPUS_REVISION) ?? 0;
  }

  getEmbeddingIndexRevision(dim: number): number | null {
    return this.getMetadataInteger(`${EMBEDDING_INDEX_REVISION_PREFIX}${dim}`);
  }

  setEmbeddingIndexRevision(dim: number, revision: number): void {
    this.setMetadataInteger(`${EMBEDDING_INDEX_REVISION_PREFIX}${dim}`, revision);
  }

  private bumpEmbeddingCorpusRevision(): void {
    retrySqliteBusy(() => {
      this.db.query(`
        INSERT INTO slack_archive_metadata(key, value) VALUES (?, '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
      `).run(EMBEDDING_CORPUS_REVISION);
    });
  }

  private getMetadataInteger(key: string): number | null {
    const value = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM slack_archive_metadata WHERE key = ?",
      )
      .get(key)?.value;
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private setMetadataInteger(key: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid Slack archive metadata integer: ${value}`);
    }
    retrySqliteBusy(() => {
      this.db.query(`
        INSERT INTO slack_archive_metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    });
  }

  upsertConversation(conversation: SlackArchiveConversation): void {
    retrySqliteBusy(() => {
      this.db.query(`
        INSERT INTO slack_archive_conversation(id, name, kind, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, kind = excluded.kind, updated_at = excluded.updated_at
      `).run(conversation.id, conversation.name, conversation.kind, Date.now());
    });
  }

  getThread(
    channelId: string,
    threadTs: string,
    options: { limit?: number } = {},
  ): SlackArchiveMessage[] {
    const limit = boundedLimit(options.limit, DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);
    return this.db
      .query<ArchiveRow, [string, string, number]>(`
        SELECT * FROM slack_archive_message
        WHERE channel_id = ? AND thread_ts = ?
        ORDER BY event_time_ms ASC, ts ASC LIMIT ?
      `)
      .all(channelId, threadTs, limit)
      .map(rowToMessage);
  }

  search(options: SlackArchiveSearchOptions): SlackArchiveSearchResult[] {
    const queryText = options.queryText?.trim() || null;
    const queryVector = options.queryVector;
    if (!queryText && !queryVector) return [];
    const limit = boundedLimit(options.limit, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT);
    const { sql: filterSql, params: filterParams } = buildFilters(options.filters);

    const lexicalRanks = new Map<string, number>();
    if (queryText) {
      const match = toFtsQuery(queryText);
      if (match) {
        const rows = this.db
          .query<{ channel_id: string; ts: string }, (string | number)[]>(`
            SELECT m.channel_id, m.ts
            FROM slack_archive_fts AS f
            JOIN slack_archive_message AS m
              ON m.rowid = f.rowid
            WHERE slack_archive_fts MATCH ? ${filterSql}
            ORDER BY bm25(slack_archive_fts), m.event_time_ms DESC
            LIMIT ?
          `)
          .all(match, ...filterParams, Math.min(MAX_RETRIEVAL_CANDIDATES, limit * 20));
        rows.forEach((row, index) => lexicalRanks.set(identity(row.channel_id, row.ts), index + 1));
      }
    }

    const vectorCosines = new Map<string, number>();
    const vectorRanks = new Map<string, number>();
    if (queryVector) {
      const desired = Math.min(MAX_RETRIEVAL_CANDIDATES, Math.max(limit * 20, 100));
      const indexSize = this.vectorIndex.size;
      let requested = Math.min(indexSize, Math.max(desired, limit * 50));
      let ranked = 0;
      while (requested > 0) {
        const hits = this.vectorIndex.search(queryVector, requested);
        const hitByRowid = new Map(hits.map((hit) => [hit.rowid, hit]));
        const byRowid = new Map<number, {
          rowid: number;
          channel_id: string;
          ts: string;
          embedding: Uint8Array;
        }>();
        // Stay below SQLite's variable limit when adaptive filtering has to
        // inspect a large fraction of the global ANN result set.
        for (let offset = 0; offset < hits.length; offset += 500) {
          const rowids = hits.slice(offset, offset + 500).map((hit) => hit.rowid);
          const placeholders = rowids.map(() => "?").join(", ");
          const rows = this.db.query<
            { rowid: number; channel_id: string; ts: string; embedding: Uint8Array },
            (string | number)[]
          >(`
            SELECT m.rowid, m.channel_id, m.ts, m.embedding
            FROM slack_archive_message AS m
            WHERE m.rowid IN (${placeholders})
              AND m.embedding IS NOT NULL ${filterSql}
          `).all(...rowids, ...filterParams);
          for (const row of rows) byRowid.set(row.rowid, row);
        }
        const currentCandidates: Array<{ key: string; cosine: number }> = [];
        vectorCosines.clear();
        vectorRanks.clear();
        for (const row of byRowid.values()) {
          const hit = hitByRowid.get(row.rowid);
          if (!hit) continue;
          const currentEmbedding = deserializeEmbedding(row.embedding);
          if (!currentEmbedding || currentEmbedding.length !== queryVector.length) continue;
          const key = identity(row.channel_id, row.ts);
          const currentCosine = cosineSimilarity(queryVector, currentEmbedding);
          // A file-backed index can lag a text edit/re-embedding until the next
          // atomic rebuild. Its recorded distance must agree with SQLite's
          // current vector or this row is a stale ANN hit and is rejected.
          if (Math.abs(currentCosine - hit.cosine) > 1e-4) continue;
          currentCandidates.push({ key, cosine: currentCosine });
        }
        currentCandidates.sort((a, b) => b.cosine - a.cosine || a.key.localeCompare(b.key));
        ranked = Math.min(currentCandidates.length, desired);
        currentCandidates.slice(0, desired).forEach((candidate, index) => {
          vectorCosines.set(candidate.key, candidate.cosine);
          vectorRanks.set(candidate.key, index + 1);
        });
        if (ranked >= desired || requested >= indexSize) break;
        requested = Math.min(indexSize, Math.max(requested + 1, requested * 2));
      }
    }

    const candidateKeys = new Set([...lexicalRanks.keys(), ...vectorRanks.keys()]);
    const scored = [...candidateKeys].map((key) => {
      const lexicalRank = lexicalRanks.get(key) ?? null;
      const vectorRank = vectorRanks.get(key) ?? null;
      const score = queryVector && queryText
        ? reciprocalRankFusion(vectorRank, lexicalRank)
        : queryVector
          ? (vectorCosines.get(key) ?? 0)
          : 1 / (lexicalRank ?? Number.POSITIVE_INFINITY);
      return { key, lexicalRank, vectorRank, score, cosine: vectorCosines.get(key) ?? null };
    });
    scored.sort((a, b) => b.score - a.score || (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity));

    const expand = options.expandThreads === true;
    const threadLimit = boundedLimit(options.threadLimit, DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);
    const results: SlackArchiveSearchResult[] = [];
    for (const entry of scored.slice(0, limit)) {
      const [channelId, ts] = splitIdentity(entry.key);
      const message = this.getMessage(channelId, ts);
      if (!message) continue;
      results.push({
        message,
        score: entry.score,
        cosine: entry.cosine,
        lexicalRank: entry.lexicalRank,
        vectorRank: entry.vectorRank,
        thread: expand ? this.getThread(channelId, message.threadTs, { limit: threadLimit }) : null,
      });
    }
    return results;
  }

  getCheckpoint(scope: string): string | null {
    return this.getCheckpointRecord(scope)?.cursor ?? null;
  }

  getCheckpointRecord(scope: string): SlackArchiveCheckpoint | null {
    const row = this.db
      .query<{ scope: string; cursor: string; metadata_json: string | null; updated_at: number }, [string]>(
        "SELECT scope, cursor, metadata_json, updated_at FROM slack_archive_checkpoint WHERE scope = ?",
      )
      .get(scope);
    return row ? {
      scope: row.scope,
      cursor: row.cursor,
      updatedAt: row.updated_at,
      metadata: parseMetadata(row.metadata_json),
    } : null;
  }

  setCheckpoint(scope: string, cursor: string): void;
  setCheckpoint(input: SlackArchiveCheckpointInput): void;
  setCheckpoint(inputOrScope: SlackArchiveCheckpointInput | string, cursor?: string): void {
    const input: SlackArchiveCheckpointInput = typeof inputOrScope === "string"
      ? { scope: inputOrScope, cursor: cursor ?? "" }
      : inputOrScope;
    retrySqliteBusy(() => {
      this.db.query(`
        INSERT INTO slack_archive_checkpoint(scope, cursor, metadata_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          cursor = excluded.cursor,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `).run(
        input.scope,
        input.cursor,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.updatedAt ?? Date.now(),
      );
    });
  }

  clearCheckpoint(scope: string): void {
    retrySqliteBusy(() => {
      this.db.query("DELETE FROM slack_archive_checkpoint WHERE scope = ?").run(scope);
    });
  }
}

function isMutableVectorIndex(
  index: SlackArchiveVectorSearcher,
): index is SlackArchiveMutableVectorIndex {
  return "upsert" in index && "remove" in index;
}

function migrateFtsRowids(db: Database): void {
  const migrate = db.transaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS slack_archive_schema_migration (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    const applied = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM slack_archive_schema_migration WHERE name = ?",
      )
      .get(FTS_ROWID_MIGRATION);
    if (applied) return;

    db.run("DELETE FROM slack_archive_fts");
    db.run(`
      INSERT INTO slack_archive_fts(rowid, channel_id, ts, text, actor_name, channel_name)
      SELECT rowid, channel_id, ts, text, coalesce(actor_name, ''), coalesce(channel_name, '')
      FROM slack_archive_message
    `);
    db.query(`
      INSERT INTO slack_archive_schema_migration(name, applied_at)
      VALUES (?, ?)
    `).run(FTS_ROWID_MIGRATION, Date.now());
  });
  migrate();
}

export function retrySqliteBusy<T>(
  operation: () => T,
  options: { attempts?: number; baseDelayMs?: number } = {},
): T {
  const attempts = Math.max(1, options.attempts ?? BUSY_RETRY_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? BUSY_RETRY_BASE_DELAY_MS);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= attempts) throw error;
      sleepSync(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code.startsWith("SQLITE_BUSY") || /SQLITE_BUSY|database is (?:locked|busy)/i.test(error.message);
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function validateMessage(input: SlackArchiveMessageInput): void {
  if (!input.channelId.trim()) throw new Error("Slack archive channelId must not be empty");
  if (!input.ts.trim() || !Number.isFinite(Number(input.ts))) {
    throw new Error(`Invalid Slack message ts: ${input.ts}`);
  }
  if (input.observedAt !== undefined && !Number.isFinite(input.observedAt)) {
    throw new Error("observedAt must be finite");
  }
  if (input.embedding && input.dim != null && input.embedding.length !== input.dim) {
    throw new Error("embedding length does not match dim");
  }
}

function slackTsToMs(ts: string): number {
  const value = Number(ts);
  if (!Number.isFinite(value)) throw new Error(`Invalid Slack message ts: ${ts}`);
  return Math.round(value * 1000);
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function buildFilters(filters: SlackArchiveFilters = {}): {
  sql: string;
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filters.channelId) { clauses.push("m.channel_id = ?"); params.push(filters.channelId); }
  if (filters.channelIds) {
    if (filters.channelIds.length === 0) clauses.push("1 = 0");
    else {
      clauses.push("m.channel_id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(filters.channelIds));
    }
  }
  if (filters.actorId) { clauses.push("m.actor_id = ?"); params.push(filters.actorId); }
  if (filters.actorKind) { clauses.push("m.actor_kind = ?"); params.push(filters.actorKind); }
  if (filters.sinceMs !== undefined) { clauses.push("m.event_time_ms >= ?"); params.push(filters.sinceMs); }
  if (filters.untilMs !== undefined) { clauses.push("m.event_time_ms <= ?"); params.push(filters.untilMs); }
  return { sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "", params };
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

const FTS_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do",
  "does", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or",
  "say", "said", "that", "the", "this", "to", "was", "what", "when", "where",
  "which", "who", "with", "would", "you",
]);

/** Quote meaningful Unicode tokens and match any of them for grep-like recall. */
function toFtsQuery(value: string): string | null {
  const terms = (value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/#:-]*/gu) ?? [])
    .filter((term) => !FTS_STOP_WORDS.has(term));
  if (terms.length === 0) return null;
  return [...new Set(terms)]
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function reciprocalRankFusion(vectorRank: number | null, lexicalRank: number | null): number {
  const offset = 60;
  const maximum = 2 / (offset + 1);
  return (
    (vectorRank == null ? 0 : 1 / (offset + vectorRank)) +
    (lexicalRank == null ? 0 : 1 / (offset + lexicalRank))
  ) / maximum;
}

function identity(channelId: string, ts: string): string {
  return `${channelId}\u0000${ts}`;
}

function splitIdentity(value: string): [string, string] {
  const separator = value.indexOf("\u0000");
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  return value ? (JSON.parse(value) as Record<string, unknown>) : null;
}

function rowToMessage(row: ArchiveRow): SlackArchiveMessage {
  return {
    channelId: row.channel_id,
    channelName: row.channel_name,
    ts: row.ts,
    threadTs: row.thread_ts,
    actorId: row.actor_id,
    userId: row.user_id,
    botId: row.bot_id,
    actorName: row.actor_name,
    actorKind: row.actor_kind as SlackArchiveMessage["actorKind"],
    text: row.text,
    files: row.files_json ? JSON.parse(row.files_json) as SlackArchiveMessage["files"] : [],
    subtype: row.subtype,
    permalink: row.permalink,
    metadata: parseMetadata(row.metadata_json),
    rawJson: parseMetadata(row.raw_json),
    embedding: deserializeEmbedding(row.embedding),
    embedModel: row.embed_model,
    dim: row.dim,
    ingestSource: row.ingest_source as SlackArchiveMessage["ingestSource"],
    observedAt: row.observed_at,
    eventTimeMs: row.event_time_ms,
  };
}
