import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import {
  isImplementedRunnerProvider,
  normalizeRunnerProvider,
  type AgentSession,
  type RunnerProvider,
  type ThreadSession,
} from "../types.ts";
import {
  SessionVersionConflictError,
  type SessionStore,
} from "./interface.ts";

const MUTATE_MAX_ATTEMPTS = 8;

type AgentSessionRow = {
  agent_name: string;
  provider: string | null;
  session_id: string | null;
  status: AgentSession["status"];
  last_activity: number | null;
  state_version: number | null;
  pending_json: string | null;
  pid: number | null;
  tmux_session_name: string | null;
};

export class SqliteSessionStore implements SessionStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        last_activity INTEGER NOT NULL,
        status TEXT NOT NULL,
        state_version INTEGER NOT NULL DEFAULT 0
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
        provider TEXT DEFAULT 'claude',
        session_id TEXT,
        status TEXT DEFAULT 'idle',
        last_activity INTEGER,
        state_version INTEGER NOT NULL DEFAULT 0,
        pending_json TEXT,
        pid INTEGER,
        tmux_session_name TEXT,
        PRIMARY KEY (thread_id, agent_name),
        FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
      )
    `);
    this.ensureSessionsColumns();
    this.ensureAgentSessionColumns();
    // Extra admins beyond the env-var bootstrap. Added by direct SQL.
    // isAdmin() reads from this table on each call (no cache), so inserts
    // take effect on the next command without a restart.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS admins (
        slack_user_id TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  async get(threadId: string): Promise<ThreadSession | undefined> {
    const row = this.db
      .query<{ json: string; state_version: number | null }, [string]>(
        "SELECT json, state_version FROM sessions WHERE thread_id = ?",
      )
      .get(threadId);
    if (!row) return undefined;
    const session = normalizeSession(JSON.parse(row.json) as ThreadSession);
    // Prefer the dedicated column when present (authoritative after dual-write).
    if (row.state_version != null) {
      session.stateVersion = row.state_version;
    }
    this.loadAgentSessions(session);
    return session;
  }

  async set(threadId: string, session: ThreadSession): Promise<void> {
    session = normalizeSession(session);
    this.withImmediateTransaction(() => {
      const current = this.readStateVersion(threadId);
      // set is last-write-wins on the parent JSON but still serializes via
      // BEGIN IMMEDIATE and dual-writes agent rows via UPSERT (no wipe).
      const nextVersion = current == null ? (session.stateVersion ?? 0) + 1 : current + 1;
      session.stateVersion = nextVersion;
      this.writeSessionRow(threadId, session, /*expectedVersion*/ null);
      this.syncAgentSessionsUpsert(threadId, session.agentSessions);
    });
  }

  async delete(threadId: string): Promise<void> {
    this.withImmediateTransaction(() => {
      this.db
        .query("DELETE FROM agent_sessions WHERE thread_id = ?")
        .run(threadId);
      this.db
        .query("DELETE FROM sessions WHERE thread_id = ?")
        .run(threadId);
    });
  }

  async getAll(): Promise<Map<string, ThreadSession>> {
    const rows = this.db
      .query<{ thread_id: string; json: string; state_version: number | null }, []>(
        "SELECT thread_id, json, state_version FROM sessions",
      )
      .all();
    const out = new Map<string, ThreadSession>();
    for (const row of rows) {
      const session = normalizeSession(JSON.parse(row.json) as ThreadSession);
      if (row.state_version != null) session.stateVersion = row.state_version;
      this.loadAgentSessions(session);
      out.set(row.thread_id, session);
    }
    return out;
  }

  async getRecent(sinceMs: number): Promise<Map<string, ThreadSession>> {
    const cutoff = Date.now() - sinceMs;
    const rows = this.db
      .query<
        { thread_id: string; json: string; state_version: number | null },
        [number]
      >(
        "SELECT thread_id, json, state_version FROM sessions WHERE last_activity >= ?",
      )
      .all(cutoff);
    const out = new Map<string, ThreadSession>();
    for (const row of rows) {
      const session = normalizeSession(JSON.parse(row.json) as ThreadSession);
      if (row.state_version != null) session.stateVersion = row.state_version;
      this.loadAgentSessions(session);
      out.set(row.thread_id, session);
    }
    return out;
  }

  async extraAdmins(): Promise<Set<string>> {
    const rows = this.db
      .query<{ slack_user_id: string }, []>(
        "SELECT slack_user_id FROM admins",
      )
      .all();
    return new Set(rows.map((r) => r.slack_user_id));
  }

  async updateActivity(threadId: string): Promise<void> {
    const now = Date.now();
    this.withImmediateTransaction(() => {
      const row = this.db
        .query<{ json: string; state_version: number | null }, [string]>(
          "SELECT json, state_version FROM sessions WHERE thread_id = ?",
        )
        .get(threadId);
      if (!row) return;
      const session = JSON.parse(row.json) as ThreadSession;
      session.lastActivity = now;
      // Keep state_version unchanged for pure activity pings — not a semantic
      // mutation. Still rewrite JSON so lastActivity survives restarts.
      this.db
        .query(
          "UPDATE sessions SET json = ?, last_activity = ? WHERE thread_id = ?",
        )
        .run(JSON.stringify(session), now, threadId);
    });
  }

  async mutateThread(
    threadId: string,
    mutator: (
      session: ThreadSession,
    ) => ThreadSession | void | Promise<ThreadSession | void>,
  ): Promise<ThreadSession> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
      const current = await this.get(threadId);
      if (!current) {
        throw new Error(`session not found: ${threadId}`);
      }
      const expectedVersion = current.stateVersion ?? 0;
      // get() already returns a fresh object from JSON.parse; mutate in place.
      const result = await mutator(current);
      const next = normalizeSession(result ?? current);
      next.stateVersion = expectedVersion + 1;
      try {
        this.withImmediateTransaction(() => {
          this.writeSessionRow(threadId, next, expectedVersion);
          this.syncAgentSessionsUpsert(threadId, next.agentSessions);
        });
        return next;
      } catch (err) {
        lastError = err;
        if (err instanceof SessionVersionConflictError) continue;
        throw err;
      }
    }
    throw lastError instanceof SessionVersionConflictError
      ? lastError
      : new SessionVersionConflictError(threadId);
  }

  async mutateAgent(
    threadId: string,
    agentName: string,
    mutator: (
      agent: AgentSession,
      session: ThreadSession,
    ) => AgentSession | void | Promise<AgentSession | void>,
  ): Promise<ThreadSession> {
    return this.mutateThread(threadId, async (session) => {
      const agent = session.agentSessions?.[agentName];
      if (!agent) {
        throw new Error(
          `agent session not found: ${threadId}/${agentName}`,
        );
      }
      const result = await mutator(agent, session);
      if (result) {
        session.agentSessions[agentName] = result;
      }
    });
  }

  /**
   * CAS write used by tests to force a version conflict without going through
   * mutateThread's retry loop.
   */
  casSet(threadId: string, session: ThreadSession, expectedVersion: number): void {
    session = normalizeSession(session);
    session.stateVersion = expectedVersion + 1;
    this.withImmediateTransaction(() => {
      this.writeSessionRow(threadId, session, expectedVersion);
      this.syncAgentSessionsUpsert(threadId, session.agentSessions);
    });
  }

  private writeSessionRow(
    threadId: string,
    session: ThreadSession,
    expectedVersion: number | null,
  ): void {
    const nextVersion = session.stateVersion ?? 0;
    const json = JSON.stringify(session);

    if (expectedVersion == null) {
      // Blind write (set): upsert without CAS.
      this.db
        .query(
          `INSERT INTO sessions (thread_id, json, last_activity, status, state_version)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             json = excluded.json,
             last_activity = excluded.last_activity,
             status = excluded.status,
             state_version = excluded.state_version`,
        )
        .run(
          threadId,
          json,
          session.lastActivity,
          session.status,
          nextVersion,
        );
      return;
    }

    // CAS write: insert only when missing; update only when version matches.
    const existing = this.readStateVersion(threadId);
    if (existing == null) {
      // Row must exist for mutateThread; insert is only valid when expected is 0
      // and nothing is there yet (shouldn't happen — mutateThread requires get).
      if (expectedVersion !== 0) {
        throw new SessionVersionConflictError(threadId, expectedVersion);
      }
      this.db
        .query(
          `INSERT INTO sessions (thread_id, json, last_activity, status, state_version)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          json,
          session.lastActivity,
          session.status,
          nextVersion,
        );
      return;
    }

    if (existing !== expectedVersion) {
      throw new SessionVersionConflictError(threadId, expectedVersion);
    }

    const result = this.db
      .query(
        `UPDATE sessions
         SET json = ?, last_activity = ?, status = ?, state_version = ?
         WHERE thread_id = ? AND state_version = ?`,
      )
      .run(
        json,
        session.lastActivity,
        session.status,
        nextVersion,
        threadId,
        expectedVersion,
      );

    if (result.changes === 0) {
      throw new SessionVersionConflictError(threadId, expectedVersion);
    }
  }

  private loadAgentSessions(session: ThreadSession): void {
    const rows = this.db
      .query<AgentSessionRow, [string]>(
        `SELECT agent_name, provider, session_id, status, last_activity,
                state_version, pending_json, pid, tmux_session_name
         FROM agent_sessions WHERE thread_id = ?`,
      )
      .all(session.threadId);

    session.agentSessions ??= {};
    for (const row of rows) {
      const existing = session.agentSessions[row.agent_name];
      let pendingFromRow: AgentSession["pendingMessages"] | undefined;
      if (row.pending_json) {
        try {
          pendingFromRow = JSON.parse(row.pending_json) as AgentSession["pendingMessages"];
        } catch {
          pendingFromRow = undefined;
        }
      }
      // Prefer agent-row fields when the row exists (dual-write soak: rows are
      // written alongside parent JSON and become authoritative after soak).
      const agent: AgentSession = {
        agentName: row.agent_name,
        provider: normalizePersistedRunnerProvider(
          row.provider ?? existing?.provider,
        ),
        sessionId: row.session_id,
        status: row.status,
        pendingMessages: pendingFromRow ?? existing?.pendingMessages ?? [],
        lastActivity: row.last_activity ?? existing?.lastActivity ?? Date.now(),
        pid: row.pid ?? existing?.pid ?? null,
        stateVersion: row.state_version ?? existing?.stateVersion ?? 0,
      };
      // Keep tmuxSessionName optional when never set (matches AgentSession shape
      // and round-trip equality for pre-tmux rows).
      const tmuxSessionName =
        row.tmux_session_name ?? existing?.tmuxSessionName;
      if (tmuxSessionName !== undefined && tmuxSessionName !== null) {
        agent.tmuxSessionName = tmuxSessionName;
      } else if (existing && existing.tmuxSessionName === null) {
        agent.tmuxSessionName = null;
      }
      session.agentSessions[row.agent_name] = agent;
    }
  }

  /**
   * Per-agent UPSERT — never delete-and-reinsert the whole set. Agents present
   * in the map are upserted; agents missing from the map are deleted so
   * intentional removals (reset) still work. Concurrent mutators that each add
   * a different agent rely on CAS retries so the second writer re-reads the
   * first writer's agent before deleting.
   */
  private syncAgentSessionsUpsert(
    threadId: string,
    agentSessions: Record<string, AgentSession>,
  ): void {
    const upsert = this.db.query(
      `INSERT INTO agent_sessions
         (thread_id, agent_name, provider, session_id, status, last_activity,
          state_version, pending_json, pid, tmux_session_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, agent_name) DO UPDATE SET
         provider = excluded.provider,
         session_id = excluded.session_id,
         status = excluded.status,
         last_activity = excluded.last_activity,
         state_version = excluded.state_version,
         pending_json = excluded.pending_json,
         pid = excluded.pid,
         tmux_session_name = excluded.tmux_session_name`,
    );

    const agents = Object.values(agentSessions);
    for (const agentSession of agents) {
      const nextAgentVersion = (agentSession.stateVersion ?? 0) + 1;
      agentSession.stateVersion = nextAgentVersion;
      upsert.run(
        threadId,
        agentSession.agentName,
        normalizePersistedRunnerProvider(agentSession.provider),
        agentSession.sessionId,
        agentSession.status,
        agentSession.lastActivity,
        nextAgentVersion,
        JSON.stringify(agentSession.pendingMessages ?? []),
        agentSession.pid,
        agentSession.tmuxSessionName ?? null,
      );
    }

    const keep = agents.map((a) => a.agentName);
    if (keep.length === 0) {
      this.db
        .query("DELETE FROM agent_sessions WHERE thread_id = ?")
        .run(threadId);
    } else {
      const placeholders = keep.map(() => "?").join(", ");
      this.db
        .query(
          `DELETE FROM agent_sessions
           WHERE thread_id = ? AND agent_name NOT IN (${placeholders})`,
        )
        .run(threadId, ...keep);
    }
  }

  private readStateVersion(threadId: string): number | null {
    const row = this.db
      .query<{ state_version: number }, [string]>(
        "SELECT state_version FROM sessions WHERE thread_id = ?",
      )
      .get(threadId);
    return row ? row.state_version : null;
  }

  private withImmediateTransaction(fn: () => void): void {
    this.db.run("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.run("COMMIT");
    } catch (err) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        // ignore rollback errors (no active transaction)
      }
      throw err;
    }
  }

  private ensureSessionsColumns(): void {
    this.ensureColumn("sessions", "state_version", "INTEGER NOT NULL DEFAULT 0");
  }

  private ensureAgentSessionColumns(): void {
    this.ensureColumn(
      "agent_sessions",
      "provider",
      "TEXT DEFAULT 'claude'",
    );
    this.ensureColumn(
      "agent_sessions",
      "state_version",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureColumn("agent_sessions", "pending_json", "TEXT");
    this.ensureColumn("agent_sessions", "pid", "INTEGER");
    this.ensureColumn("agent_sessions", "tmux_session_name", "TEXT");
  }

  private ensureColumn(
    table: "sessions" | "agent_sessions",
    column: string,
    ddl: string,
  ): void {
    const columns = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all();
    if (columns.some((c) => c.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function normalizeSession(session: ThreadSession): ThreadSession {
  session.provider = normalizePersistedRunnerProvider(session.provider);
  session.leadSessionId ??= session.sessionId;
  session.agentSessions ??= {};
  for (const agentSession of Object.values(session.agentSessions)) {
    agentSession.provider = normalizePersistedRunnerProvider(
      agentSession.provider,
    );
    agentSession.stateVersion ??= 0;
    agentSession.pendingMessages ??= [];
    agentSession.pid ??= null;
  }
  // Migration: existing sessions before worktreePaths was added default to {}
  session.worktreePaths ??= {};
  session.muted ??= false;
  // Driver-mode migration — rows written before the driver abstraction
  // landed default to "headless" (the historical behavior).
  session.driverMode ??= "headless";
  session.tmuxSessionName ??= null;
  session.topLevelTmuxAgent ??= null;
  // Migration: dormant / dormantAnnounced / humanParticipants added for the
  // attention gate. Pre-existing sessions default to "awake, never announced,
  // no recorded participants" — they re-accumulate naturally as new messages
  // arrive.
  session.dormant ??= false;
  session.dormantAnnounced ??= false;
  session.humanParticipants ??= [];
  session.pipelineGuardRetryCount ??= 0;
  session.stateVersion ??= 0;
  return session;
}

function normalizePersistedRunnerProvider(value: unknown): RunnerProvider {
  const provider = normalizeRunnerProvider(value);
  return isImplementedRunnerProvider(provider) ? provider : "claude";
}
