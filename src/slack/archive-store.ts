import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  cosineSim,
  deserializeEmbedding,
  serializeEmbedding,
} from "../memory/sqlite.ts";
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
const MAX_VECTOR_CANDIDATES = 50_000;

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

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
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
  }

  close(): void {
    this.db.close();
  }

  upsertMessage(input: SlackArchiveMessageInput): SlackArchiveWriteResult {
    validateMessage(input);
    const observedAt = input.observedAt ?? Date.now();
    const existing = this.db
      .query<{ observed_at: number; ingest_source: string }, [string, string]>(
        "SELECT observed_at, ingest_source FROM slack_archive_message WHERE channel_id = ? AND ts = ?",
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
    const transaction = this.db.transaction(() => {
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
      this.db
        .query("DELETE FROM slack_archive_fts WHERE channel_id = ? AND ts = ?")
        .run(input.channelId, input.ts);
      this.db.query(`
        INSERT INTO slack_archive_fts(channel_id, ts, text, actor_name, channel_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        input.channelId,
        input.ts,
        input.text,
        input.actorName ?? "",
        input.channelName ?? "",
      );
    });
    transaction();
    return existing ? "updated" : "inserted";
  }

  upsertMessages(inputs: SlackArchiveMessageInput[]): SlackArchiveWriteResult[] {
    if (inputs.length === 0) return [];
    const transaction = this.db.transaction((rows: SlackArchiveMessageInput[]) =>
      rows.map((row) => this.upsertMessage(row))
    );
    return transaction(inputs);
  }

  getMessage(channelId: string, ts: string): SlackArchiveMessage | null {
    const row = this.db
      .query<ArchiveRow, [string, string]>(
        "SELECT * FROM slack_archive_message WHERE channel_id = ? AND ts = ?",
      )
      .get(channelId, ts);
    return row ? rowToMessage(row) : null;
  }

  upsertConversation(conversation: SlackArchiveConversation): void {
    this.db.query(`
      INSERT INTO slack_archive_conversation(id, name, kind, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, kind = excluded.kind, updated_at = excluded.updated_at
    `).run(conversation.id, conversation.name, conversation.kind, Date.now());
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
              ON m.channel_id = f.channel_id AND m.ts = f.ts
            WHERE slack_archive_fts MATCH ? ${filterSql}
            ORDER BY bm25(slack_archive_fts), m.event_time_ms DESC
            LIMIT ?
          `)
          .all(match, ...filterParams, Math.min(MAX_VECTOR_CANDIDATES, limit * 20));
        rows.forEach((row, index) => lexicalRanks.set(identity(row.channel_id, row.ts), index + 1));
      }
    }

    const vectorCosines = new Map<string, number>();
    const vectorRanks = new Map<string, number>();
    if (queryVector) {
      const rows = this.db
        .query<ArchiveRow, (string | number)[]>(`
          SELECT * FROM slack_archive_message AS m
          WHERE m.embedding IS NOT NULL ${filterSql}
          ORDER BY m.event_time_ms DESC LIMIT ?
        `)
        .all(...filterParams, MAX_VECTOR_CANDIDATES);
      const ranked = rows
        .map((row) => ({ row, cosine: cosineSim(queryVector, deserializeEmbedding(row.embedding)!) }))
        .sort((a, b) => b.cosine - a.cosine || b.row.event_time_ms - a.row.event_time_ms);
      ranked.forEach((entry, index) => {
        const key = identity(entry.row.channel_id, entry.row.ts);
        vectorCosines.set(key, entry.cosine);
        vectorRanks.set(key, index + 1);
      });
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
  }

  clearCheckpoint(scope: string): void {
    this.db.query("DELETE FROM slack_archive_checkpoint WHERE scope = ?").run(scope);
  }
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
  if (filters.actorId) { clauses.push("m.actor_id = ?"); params.push(filters.actorId); }
  if (filters.actorKind) { clauses.push("m.actor_kind = ?"); params.push(filters.actorKind); }
  if (filters.sinceMs !== undefined) { clauses.push("m.event_time_ms >= ?"); params.push(filters.sinceMs); }
  if (filters.untilMs !== undefined) { clauses.push("m.event_time_ms <= ?"); params.push(filters.untilMs); }
  return { sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "", params };
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
