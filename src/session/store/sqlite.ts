import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ThreadSession } from "../types.ts";
import type { SessionStore } from "./interface.ts";

export class SqliteSessionStore implements SessionStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        last_activity INTEGER NOT NULL,
        status TEXT NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)",
    );
  }

  close(): void {
    this.db.close();
  }

  async get(threadId: string): Promise<ThreadSession | undefined> {
    const row = this.db
      .query<{ json: string }, [string]>(
        "SELECT json FROM sessions WHERE thread_id = ?",
      )
      .get(threadId);
    return row ? (JSON.parse(row.json) as ThreadSession) : undefined;
  }

  async set(threadId: string, session: ThreadSession): Promise<void> {
    this.db
      .query(
        `INSERT INTO sessions (thread_id, json, last_activity, status)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           json = excluded.json,
           last_activity = excluded.last_activity,
           status = excluded.status`,
      )
      .run(threadId, JSON.stringify(session), session.lastActivity, session.status);
  }

  async delete(threadId: string): Promise<void> {
    this.db
      .query("DELETE FROM sessions WHERE thread_id = ?")
      .run(threadId);
  }

  async getAll(): Promise<Map<string, ThreadSession>> {
    const rows = this.db
      .query<{ thread_id: string; json: string }, []>(
        "SELECT thread_id, json FROM sessions",
      )
      .all();
    const out = new Map<string, ThreadSession>();
    for (const row of rows) {
      out.set(row.thread_id, JSON.parse(row.json) as ThreadSession);
    }
    return out;
  }

  async getRecent(sinceMs: number): Promise<Map<string, ThreadSession>> {
    const cutoff = Date.now() - sinceMs;
    const rows = this.db
      .query<{ thread_id: string; json: string }, [number]>(
        "SELECT thread_id, json FROM sessions WHERE last_activity >= ?",
      )
      .all(cutoff);
    const out = new Map<string, ThreadSession>();
    for (const row of rows) {
      out.set(row.thread_id, JSON.parse(row.json) as ThreadSession);
    }
    return out;
  }

  async updateActivity(threadId: string): Promise<void> {
    const now = Date.now();
    const row = this.db
      .query<{ json: string }, [string]>(
        "SELECT json FROM sessions WHERE thread_id = ?",
      )
      .get(threadId);
    if (!row) return;
    const session = JSON.parse(row.json) as ThreadSession;
    session.lastActivity = now;
    this.db
      .query(
        "UPDATE sessions SET json = ?, last_activity = ? WHERE thread_id = ?",
      )
      .run(JSON.stringify(session), now, threadId);
  }
}
