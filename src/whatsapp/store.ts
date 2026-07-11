import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CreateWaTaskInput,
  UpdateWaTaskInput,
  WaMessage,
  WaMessageInput,
  WaTask,
  WaTaskPriority,
  WaTaskStatus,
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
  processed: number;
};

type TaskRow = {
  id: string;
  task: string;
  owner: string | null;
  priority: string | null;
  status: string;
  notes: string | null;
  group_jid: string | null;
  source_msg_id: string | null;
  notion_page_id: string | null;
  notion_dirty: number;
  created_at: number;
  updated_at: number;
};

/**
 * SQLite-backed store for WhatsApp ingestion. Follows the same `bun:sqlite`
 * WAL patterns as `SqliteSessionStore` / `SqliteMemoryStore`: single-writer,
 * schema created idempotently in the constructor.
 *
 * `wa_messages` is append-only — `upsertMessage` uses INSERT OR IGNORE so that
 * history backfill and live events (which overlap by message id) dedupe on the
 * primary key rather than clobbering each other.
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
        raw TEXT,
        processed INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_messages_group_jid ON wa_messages(group_jid)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_messages_processed ON wa_messages(processed)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_messages_ts ON wa_messages(ts)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wa_tasks (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        owner TEXT,
        priority TEXT CHECK(priority IN ('p0','p1','p2')),
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open','in-progress','done','blocked')),
        notes TEXT,
        group_jid TEXT,
        source_msg_id TEXT,
        notion_page_id TEXT,
        notion_dirty INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_tasks_group_jid ON wa_tasks(group_jid)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_tasks_owner ON wa_tasks(owner)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wa_tasks_status ON wa_tasks(status)",
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Run `fn` inside a single SQLite transaction: every write it performs commits
   * atomically, or — if `fn` throws — rolls back as a unit and rethrows. Used by
   * the extraction sweep to make a group's "apply ops + markProcessed" one
   * indivisible step, so a crash between the two can't re-extract already-applied
   * messages next boot. `fn` MUST stay synchronous (bun:sqlite transactions can't
   * span an await — an await inside would commit early and defeat the guarantee).
   */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- messages -----------------------------------------------------------

  /**
   * Insert a message, ignoring if the id already exists. Backfill and live
   * paths both call this and overlap by design — the primary key dedupes.
   */
  upsertMessage(msg: WaMessageInput): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO wa_messages
           (id, group_jid, group_name, sender_jid, sender_name, ts, text, reply_to_id, raw, processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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

  /**
   * Distinct group JIDs that still have unprocessed messages, oldest-group
   * first (ordered by each group's oldest pending message). The sweep iterates
   * these and pulls a bounded per-group batch, so one group that keeps failing
   * extraction can't monopolise a global batch and starve the others.
   */
  getGroupsWithUnprocessed(): string[] {
    const rows = this.db
      .query<{ group_jid: string }, []>(
        `SELECT group_jid FROM wa_messages
           WHERE processed = 0
           GROUP BY group_jid
           ORDER BY MIN(ts) ASC`,
      )
      .all();
    return rows.map((r) => r.group_jid);
  }

  /**
   * Fetch a single message by id regardless of processed state. Lets the
   * extraction prompt resolve a reply's quoted message even when that message
   * was consumed by an earlier sweep and so isn't in the current batch.
   */
  getMessage(id: string): WaMessage | undefined {
    const row = this.db
      .query<MessageRow, [string]>("SELECT * FROM wa_messages WHERE id = ?")
      .get(id);
    return row ? rowToMessage(row) : undefined;
  }

  /** Oldest-first batch of one group's messages the sweep hasn't consumed yet. */
  getUnprocessedMessagesForGroup(groupJid: string, limit: number): WaMessage[] {
    const rows = this.db
      .query<MessageRow, [string, number]>(
        "SELECT * FROM wa_messages WHERE processed = 0 AND group_jid = ? ORDER BY ts ASC LIMIT ?",
      )
      .all(groupJid, limit);
    return rows.map(rowToMessage);
  }

  /** Mark a batch of messages as consumed. No-op on an empty list. */
  markProcessed(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.query(
      "UPDATE wa_messages SET processed = 1 WHERE id = ?",
    );
    const txn = this.db.transaction((batch: string[]) => {
      for (const id of batch) stmt.run(id);
    });
    txn(ids);
  }

  // ---- tasks --------------------------------------------------------------

  createTask(input: CreateWaTaskInput): WaTask {
    const now = Date.now();
    const task: WaTask = {
      id: input.id ?? crypto.randomUUID(),
      task: input.task,
      owner: input.owner ?? null,
      priority: input.priority ?? null,
      status: input.status ?? "open",
      notes: input.notes ?? null,
      groupJid: input.groupJid ?? null,
      sourceMsgId: input.sourceMsgId ?? null,
      notionPageId: null,
      // A fresh task is unsynced by definition.
      notionDirty: true,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO wa_tasks
           (id, task, owner, priority, status, notes, group_jid, source_msg_id, notion_page_id, notion_dirty, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        task.id,
        task.task,
        task.owner,
        task.priority,
        task.status,
        task.notes,
        task.groupJid,
        task.sourceMsgId,
        task.notionPageId,
        task.createdAt,
        task.updatedAt,
      );
    return task;
  }

  /** Apply a partial patch. Returns the updated task, or undefined if id is unknown. */
  updateTask(id: string, patch: UpdateWaTaskInput): WaTask | undefined {
    const existing = this.getTask(id);
    if (!existing) return undefined;
    const updated: WaTask = {
      ...existing,
      task: patch.task ?? existing.task,
      owner: patch.owner !== undefined ? patch.owner : existing.owner,
      priority: patch.priority !== undefined ? patch.priority : existing.priority,
      status: patch.status ?? existing.status,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
      // A local edit invalidates whatever is currently in Notion.
      notionDirty: true,
      updatedAt: Date.now(),
    };
    this.db
      .query(
        `UPDATE wa_tasks SET
           task = ?, owner = ?, priority = ?, status = ?, notes = ?, notion_dirty = 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.task,
        updated.owner,
        updated.priority,
        updated.status,
        updated.notes,
        updated.updatedAt,
        id,
      );
    return updated;
  }

  getTask(id: string): WaTask | undefined {
    const row = this.db
      .query<TaskRow, [string]>("SELECT * FROM wa_tasks WHERE id = ?")
      .get(id);
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Active tasks — anything not done (open, in-progress, blocked) — optionally
   * scoped to one group. The extraction prompt must see in-progress/blocked
   * tasks too, or the model can neither complete them by id nor avoid
   * recreating them.
   */
  getOpenTasks(groupJid?: string): WaTask[] {
    const rows = groupJid
      ? this.db
          .query<TaskRow, [string]>(
            "SELECT * FROM wa_tasks WHERE status != 'done' AND group_jid = ? ORDER BY created_at ASC",
          )
          .all(groupJid)
      : this.db
          .query<TaskRow, []>(
            "SELECT * FROM wa_tasks WHERE status != 'done' ORDER BY created_at ASC",
          )
          .all();
    return rows.map(rowToTask);
  }

  getTasksByOwner(owner: string): WaTask[] {
    const rows = this.db
      .query<TaskRow, [string]>(
        "SELECT * FROM wa_tasks WHERE owner = ? ORDER BY created_at ASC",
      )
      .all(owner);
    return rows.map(rowToTask);
  }

  /** Record the Notion page id for a freshly created row and mark it in sync. */
  setNotionPageId(taskId: string, pageId: string): void {
    this.db
      .query(
        "UPDATE wa_tasks SET notion_page_id = ?, notion_dirty = 0, updated_at = ? WHERE id = ?",
      )
      .run(pageId, Date.now(), taskId);
  }

  /**
   * Clear the dirty flag for rows whose Notion update landed. Does NOT bump
   * updated_at — this is a sync bookkeeping write, not a content change, and
   * bumping it would immediately re-dirty the row against the value just synced.
   * No-op on an empty list.
   */
  markNotionSynced(taskIds: string[]): void {
    if (taskIds.length === 0) return;
    const stmt = this.db.query(
      "UPDATE wa_tasks SET notion_dirty = 0 WHERE id = ?",
    );
    const txn = this.db.transaction((batch: string[]) => {
      for (const id of batch) stmt.run(id);
    });
    txn(taskIds);
  }

  allTasks(): WaTask[] {
    const rows = this.db
      .query<TaskRow, []>("SELECT * FROM wa_tasks ORDER BY created_at ASC")
      .all();
    return rows.map(rowToTask);
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
    processed: row.processed === 1,
  };
}

function rowToTask(row: TaskRow): WaTask {
  return {
    id: row.id,
    task: row.task,
    owner: row.owner,
    // CHECK constraints guarantee these columns only ever hold valid values.
    priority: row.priority as WaTaskPriority | null,
    status: row.status as WaTaskStatus,
    notes: row.notes,
    groupJid: row.group_jid,
    sourceMsgId: row.source_msg_id,
    notionPageId: row.notion_page_id,
    notionDirty: row.notion_dirty === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
