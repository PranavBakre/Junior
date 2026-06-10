import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { SlackActionButtonSpec } from "./formatting.ts";

export type SlackActionStatus =
  | "active"
  | "clicked"
  | "expired"
  | "disabled"
  | "failed";

export interface SlackActionRecord {
  token: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  messageText: string;
  actionId: string;
  actionType: SlackActionButtonSpec["type"];
  action: SlackActionButtonSpec;
  sourceAgent: string;
  createdByUserId: string | null;
  createdAt: number;
  expiresAt: number;
  clickedAt: number | null;
  clickedByUserId: string | null;
  status: SlackActionStatus;
}

export interface CreateSlackActionRecord {
  token: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  messageText: string;
  action: SlackActionButtonSpec;
  sourceAgent: string;
  createdByUserId?: string | null;
  expiresAt?: number;
}

const STORAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class SlackActionStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_action_buttons (
        token TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        message_text TEXT NOT NULL DEFAULT '',
        action_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        action_json TEXT NOT NULL,
        source_agent TEXT NOT NULL,
        created_by_user_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        clicked_at INTEGER,
        clicked_by_user_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'clicked', 'expired', 'disabled', 'failed'))
      )
    `);
    this.ensureMessageTextColumn();
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_slack_actions_thread_agent ON slack_action_buttons(thread_ts, source_agent, status)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_slack_actions_message ON slack_action_buttons(channel_id, message_ts)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_slack_actions_expires ON slack_action_buttons(expires_at, status)",
    );
  }

  close(): void {
    this.db.close();
  }

  async createMany(records: CreateSlackActionRecord[]): Promise<void> {
    if (records.length === 0) return;
    const now = Date.now();
    const insert = this.db.query(
      `INSERT INTO slack_action_buttons
       (token, channel_id, thread_ts, message_ts, action_id, action_type, action_json,
        message_text, source_agent, created_by_user_id, created_at, expires_at, clicked_at, clicked_by_user_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active')`,
    );
    const txn = this.db.transaction((rows: CreateSlackActionRecord[]) => {
      for (const row of rows) {
        insert.run(
          row.token,
          row.channelId,
          row.threadTs,
          row.messageTs,
          row.action.id,
          row.action.type,
          JSON.stringify(row.action),
          row.messageText,
          row.sourceAgent,
          row.createdByUserId ?? null,
          now,
          row.expiresAt ?? now + STORAGE_TTL_MS,
        );
      }
    });
    txn(records);
  }

  async get(token: string): Promise<SlackActionRecord | null> {
    const row = this.db
      .query<ActionRow, [string]>(
        "SELECT * FROM slack_action_buttons WHERE token = ?",
      )
      .get(token);
    return row ? toRecord(row) : null;
  }

  async claim(token: string, userId: string, now = Date.now()): Promise<SlackActionRecord | null> {
    this.expireStale(now);
    const record = await this.get(token);
    if (!record || record.status !== "active" || record.expiresAt <= now) {
      if (record?.status === "active" && record.expiresAt <= now) {
        await this.markExpired(token);
      }
      return null;
    }

    const result = this.db
      .query(
        `UPDATE slack_action_buttons
         SET status = 'clicked', clicked_at = ?, clicked_by_user_id = ?
         WHERE token = ? AND status = 'active'`,
      )
      .run(now, userId, token);
    if (result.changes === 0) return null;
    return {
      ...record,
      status: "clicked",
      clickedAt: now,
      clickedByUserId: userId,
    };
  }

  async markFailed(token: string): Promise<void> {
    this.db
      .query("UPDATE slack_action_buttons SET status = 'failed' WHERE token = ?")
      .run(token);
  }

  async disableSourceAgentActions(
    threadTs: string,
    sourceAgent: string,
    exceptMessageTs?: string,
  ): Promise<Array<{ channelId: string; messageTs: string; messageText: string }>> {
    const params: string[] = [threadTs, sourceAgent];
    let where =
      "thread_ts = ? AND source_agent = ? AND status = 'active'";
    if (exceptMessageTs) {
      where += " AND message_ts != ?";
      params.push(exceptMessageTs);
    }

    const rows = this.db
      .query<{ channel_id: string; message_ts: string; message_text: string }, string[]>(
        `SELECT DISTINCT channel_id, message_ts, message_text FROM slack_action_buttons WHERE ${where}`,
      )
      .all(...params);
    this.db
      .query(`UPDATE slack_action_buttons SET status = 'disabled' WHERE ${where}`)
      .run(...params);
    return rows.map((row) => ({
      channelId: row.channel_id,
      messageTs: row.message_ts,
      messageText: row.message_text,
    }));
  }

  async disableMessageActions(channelId: string, messageTs: string): Promise<void> {
    this.db
      .query(
        `UPDATE slack_action_buttons
         SET status = 'disabled'
         WHERE channel_id = ? AND message_ts = ? AND status = 'active'`,
      )
      .run(channelId, messageTs);
  }

  private async markExpired(token: string): Promise<void> {
    this.db
      .query(
        "UPDATE slack_action_buttons SET status = 'expired' WHERE token = ? AND status = 'active'",
      )
      .run(token);
  }

  private expireStale(now: number): void {
    this.db
      .query(
        "UPDATE slack_action_buttons SET status = 'expired' WHERE status = 'active' AND expires_at <= ?",
      )
      .run(now);
  }

  private ensureMessageTextColumn(): void {
    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(slack_action_buttons)")
      .all();
    if (columns.some((column) => column.name === "message_text")) return;
    this.db.run(
      "ALTER TABLE slack_action_buttons ADD COLUMN message_text TEXT NOT NULL DEFAULT ''",
    );
  }
}

interface ActionRow {
  token: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string;
  message_text: string;
  action_id: string;
  action_type: SlackActionButtonSpec["type"];
  action_json: string;
  source_agent: string;
  created_by_user_id: string | null;
  created_at: number;
  expires_at: number;
  clicked_at: number | null;
  clicked_by_user_id: string | null;
  status: SlackActionStatus;
}

function toRecord(row: ActionRow): SlackActionRecord {
  return {
    token: row.token,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    messageTs: row.message_ts,
    messageText: row.message_text,
    actionId: row.action_id,
    actionType: row.action_type,
    action: JSON.parse(row.action_json) as SlackActionButtonSpec,
    sourceAgent: row.source_agent,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    clickedAt: row.clicked_at,
    clickedByUserId: row.clicked_by_user_id,
    status: row.status,
  };
}
