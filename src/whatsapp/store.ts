import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  WaGroupSummary,
  WaMessage,
  WaMessageInput,
  WaMessageQuery,
  WaSearchQuery,
} from "./types.ts";

type MessageRow = {
  id: string;
  group_jid: string;
  group_name: string | null;
  sender_jid: string;
  sender_name: string | null;
  ts: number;
  text: string | null;
  reply_to_id: string | null;
  raw: string | null;
};

/**
 * SQLite-backed store for WhatsApp ingestion. Follows the same `bun:sqlite`
 * WAL patterns as `SqliteSessionStore` / `SqliteMemoryStore`: single-writer,
 * schema created idempotently in the constructor.
 *
 * `wa_messages` is append-only — `upsertMessage` uses INSERT OR IGNORE so that
 * history backfill and live events (which overlap by message id) dedupe on the
 * primary key rather than clobbering each other. Databases created by the
 * retired extraction pipeline may carry extra columns (`processed`) and a
 * `wa_tasks` table; both are harmless leftovers this store never touches.
 */
export class WhatsAppStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wa_messages (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        group_name TEXT,
        sender_jid TEXT NOT NULL,
        sender_name TEXT,
        ts INTEGER NOT NULL,
        text TEXT,
        reply_to_id TEXT,
        raw TEXT
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_messages_group_jid ON wa_messages(group_jid)",
    );
    // Composite DESC indexes matching the (ts DESC, id DESC) keyset ordering,
    // so paged reads/search batches are index seeks — without them each batch
    // re-walks and re-sorts everything newer than the cursor, and the whole
    // scan goes quadratic on a synchronous connection.
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_messages_ts_id ON wa_messages(ts DESC, id DESC)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_messages_group_ts_id ON wa_messages(group_jid, ts DESC, id DESC)",
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Insert a message, ignoring if the id already exists. Backfill and live
   * paths both call this and overlap by design — the primary key dedupes.
   */
  upsertMessage(msg: WaMessageInput): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO wa_messages
           (id, group_jid, group_name, sender_jid, sender_name, ts, text, reply_to_id, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.groupJid,
        msg.groupName,
        msg.senderJid,
        msg.senderName,
        msg.ts,
        msg.text,
        msg.replyToId,
        msg.raw,
      );
  }

  /** Fetch a single message by id. */
  getMessage(id: string): WaMessage | undefined {
    const row = this.db
      .query<MessageRow, [string]>(
        `SELECT id, group_jid, group_name, sender_jid, sender_name, ts, text, reply_to_id, raw
           FROM wa_messages WHERE id = ?`,
      )
      .get(id);
    return row ? rowToMessage(row) : undefined;
  }

  /**
   * Every group with stored messages, most recently active first. `groupName`
   * is the subject of the newest message that recorded one, so renames win.
   */
  listGroups(): WaGroupSummary[] {
    const rows = this.db
      .query<
        {
          group_jid: string;
          group_name: string | null;
          message_count: number;
          first_ts: number;
          last_ts: number;
        },
        []
      >(
        `SELECT group_jid,
                (SELECT m2.group_name FROM wa_messages m2
                   WHERE m2.group_jid = m.group_jid AND m2.group_name IS NOT NULL
                   ORDER BY m2.ts DESC, m2.rowid DESC LIMIT 1) AS group_name,
                COUNT(*) AS message_count,
                MIN(ts) AS first_ts,
                MAX(ts) AS last_ts
           FROM wa_messages m
          GROUP BY group_jid
          ORDER BY last_ts DESC`,
      )
      .all();
    return rows.map((r) => ({
      groupJid: r.group_jid,
      groupName: r.group_name,
      messageCount: r.message_count,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
    }));
  }

  /**
   * The newest messages matching the filters, returned in chronological
   * (oldest-first) order so a transcript reads top-to-bottom. Ordering is a
   * stable (ts, id) pair. To page backwards, pass the earliest returned
   * message's `ts` as `beforeTs` AND its `id` as `beforeId` — timestamps are
   * whole seconds, and without the id tie-breaker a page boundary inside a
   * same-second run would make the rest of that second unreachable.
   */
  getMessages(query: WaMessageQuery): WaMessage[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.groupJid) {
      where.push("group_jid = ?");
      params.push(query.groupJid);
    }
    if (query.beforeTs !== undefined) {
      if (query.beforeId !== undefined) {
        // Row-value comparison (not an OR chain) so SQLite can seek the
        // composite (ts DESC, id DESC) index instead of scanning.
        where.push("(ts, id) < (?, ?)");
        params.push(query.beforeTs, query.beforeId);
      } else {
        where.push("ts < ?");
        params.push(query.beforeTs);
      }
    }
    if (query.afterTs !== undefined) {
      where.push("ts >= ?");
      params.push(query.afterTs);
    }
    params.push(query.limit);
    const rows = this.db
      .query<MessageRow, (string | number)[]>(
        `SELECT id, group_jid, group_name, sender_jid, sender_name, ts, text, reply_to_id, raw
           FROM wa_messages
           ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(...params);
    return rows.map(rowToMessage).reverse();
  }

  /**
   * Case-insensitive substring search over message text (and optionally sender
   * name/JID), newest match first. Matching happens in JS via `toLowerCase()`
   * so it stays case-insensitive for non-ASCII text too — SQLite's LIKE only
   * folds ASCII. The scan walks rows newest-first in batches and stops at
   * `limit` matches; volumes here are small enough that FTS would be ceremony.
   * `raw` is not loaded during the scan and is returned as null.
   */
  searchMessages(query: WaSearchQuery): WaMessage[] {
    // Keyset batches on the same stable (ts, id) ordering `getMessages` uses:
    // each batch resumes strictly below the previous one, so every row is
    // visited at most once (OFFSET would re-walk all preceding rows per batch).
    const scanWhere: string[] = ["text IS NOT NULL"];
    const scanParams: string[] = [];
    if (query.groupJid) {
      scanWhere.push("group_jid = ?");
      scanParams.push(query.groupJid);
    }
    // Row-value cursor predicate: seekable via the composite (ts DESC, id
    // DESC) indexes, so each batch resumes where the last ended and the whole
    // scan stays linear.
    const stmt = this.db.query<Omit<MessageRow, "raw">, (string | number)[]>(
      `SELECT id, group_jid, group_name, sender_jid, sender_name, ts, text, reply_to_id
         FROM wa_messages
        WHERE ${scanWhere.join(" AND ")}
          AND (ts, id) < (?, ?)
        ORDER BY ts DESC, id DESC LIMIT ?`,
    );

    const needle = query.query.toLowerCase();
    const senderNeedle = query.sender?.toLowerCase();
    const matches: WaMessage[] = [];
    const BATCH = 500;
    // Cursor starts above any real row (WhatsApp ids are printable ASCII).
    let cursorTs = Number.MAX_SAFE_INTEGER;
    let cursorId = "￿";
    while (matches.length < query.limit) {
      const rows = stmt.all(...scanParams, cursorTs, cursorId, BATCH);
      for (const row of rows) {
        if (!row.text!.toLowerCase().includes(needle)) continue;
        if (
          senderNeedle !== undefined &&
          !(row.sender_name ?? "").toLowerCase().includes(senderNeedle) &&
          !row.sender_jid.toLowerCase().includes(senderNeedle)
        ) {
          continue;
        }
        matches.push(rowToMessage({ ...row, raw: null }));
        if (matches.length >= query.limit) break;
      }
      if (rows.length < BATCH) break; // scanned everything
      const last = rows[rows.length - 1]!;
      cursorTs = last.ts;
      cursorId = last.id;
    }
    return matches;
  }
}

function rowToMessage(row: MessageRow): WaMessage {
  return {
    id: row.id,
    groupJid: row.group_jid,
    groupName: row.group_name,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    ts: row.ts,
    text: row.text,
    replyToId: row.reply_to_id,
    raw: row.raw,
  };
}
