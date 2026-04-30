import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { AgentSession, ThreadSession } from "../types.ts";
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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        thread_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        session_id TEXT,
        status TEXT DEFAULT 'idle',
        last_activity INTEGER,
        PRIMARY KEY (thread_id, agent_name),
        FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
      )
    `);
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
    if (!row) return undefined;
    const session = normalizeSession(JSON.parse(row.json) as ThreadSession);
    this.loadAgentSessions(session);
    return session;
  }

  async set(threadId: string, session: ThreadSession): Promise<void> {
    session = normalizeSession(session);
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
    this.syncAgentSessions(threadId, session.agentSessions);
  }

  async delete(threadId: string): Promise<void> {
    this.db
      .query("DELETE FROM agent_sessions WHERE thread_id = ?")
      .run(threadId);
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
      const session = normalizeSession(JSON.parse(row.json) as ThreadSession);
      this.loadAgentSessions(session);
      out.set(row.thread_id, session);
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
      const session = normalizeSession(JSON.parse(row.json) as ThreadSession);
      this.loadAgentSessions(session);
      out.set(row.thread_id, session);
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

  private loadAgentSessions(session: ThreadSession): void {
    const rows = this.db
      .query<
        {
          agent_name: string;
          session_id: string | null;
          status: AgentSession["status"];
          last_activity: number | null;
        },
        [string]
      >(
        "SELECT agent_name, session_id, status, last_activity FROM agent_sessions WHERE thread_id = ?",
      )
      .all(session.threadId);

    session.agentSessions ??= {};
    for (const row of rows) {
      const existing = session.agentSessions[row.agent_name];
      session.agentSessions[row.agent_name] = {
        agentName: row.agent_name,
        sessionId: row.session_id,
        status: row.status,
        pendingMessages: existing?.pendingMessages ?? [],
        lastActivity: row.last_activity ?? existing?.lastActivity ?? Date.now(),
        pid: existing?.pid ?? null,
      };
    }
  }

  private syncAgentSessions(
    threadId: string,
    agentSessions: Record<string, AgentSession>,
  ): void {
    const del = this.db.query(
      "DELETE FROM agent_sessions WHERE thread_id = ?",
    );
    const insert = this.db.query(
      `INSERT INTO agent_sessions
       (thread_id, agent_name, session_id, status, last_activity)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const txn = this.db.transaction((sessions: AgentSession[]) => {
      del.run(threadId);
      for (const agentSession of sessions) {
        insert.run(
          threadId,
          agentSession.agentName,
          agentSession.sessionId,
          agentSession.status,
          agentSession.lastActivity,
        );
      }
    });

    txn(Object.values(agentSessions));
  }
}

function normalizeSession(session: ThreadSession): ThreadSession {
  session.leadSessionId ??= session.sessionId;
  session.agentSessions ??= {};
  // Migration: existing sessions before worktreePaths was added default to {}
  session.worktreePaths ??= {};
  return session;
}
