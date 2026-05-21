import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
  WorkflowLastRunStatus,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowState,
} from "./types.ts";

export interface WorkflowStore {
  getState(name: string): Promise<WorkflowState | undefined>;
  setState(state: WorkflowState): Promise<void>;
  listStates(): Promise<WorkflowState[]>;
  createRun(run: WorkflowRun): Promise<void>;
  updateRun(run: WorkflowRun): Promise<void>;
  getRun(id: string): Promise<WorkflowRun | undefined>;
  listRuns(name: string, limit?: number): Promise<WorkflowRun[]>;
  close?(): void;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private states = new Map<string, WorkflowState>();
  private runs = new Map<string, WorkflowRun>();

  async getState(name: string): Promise<WorkflowState | undefined> {
    return this.states.get(name);
  }

  async setState(state: WorkflowState): Promise<void> {
    this.states.set(state.name, { ...state });
  }

  async listStates(): Promise<WorkflowState[]> {
    return [...this.states.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async updateRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async getRun(id: string): Promise<WorkflowRun | undefined> {
    return this.runs.get(id);
  }

  async listRuns(name: string, limit = 10): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.workflowName === name)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }
}

export class SqliteWorkflowStore implements WorkflowStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_states (
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('active', 'stopped', 'invalid')),
        active_version_hash TEXT NOT NULL,
        source_path TEXT NOT NULL,
        last_loaded_at INTEGER NOT NULL,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_run_status TEXT CHECK (last_run_status IN ('success', 'failed', 'skipped')),
        last_error TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        workflow_version_hash TEXT NOT NULL,
        source_path TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('schedule', 'command', 'event', 'manual')),
        actor_slack_user_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        artifact_path TEXT NOT NULL,
        slack_channel TEXT,
        slack_thread_ts TEXT,
        error TEXT
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS workflow_runs_workflow_started_idx
      ON workflow_runs (workflow_name, started_at DESC)
    `);
  }

  close(): void {
    this.db.close();
  }

  async getState(name: string): Promise<WorkflowState | undefined> {
    const row = this.db
      .query<StateRow, [string]>("SELECT * FROM workflow_states WHERE name = ?")
      .get(name);
    return row ? stateFromRow(row) : undefined;
  }

  async setState(state: WorkflowState): Promise<void> {
    this.db
      .query(
        `INSERT INTO workflow_states
         (name, status, active_version_hash, source_path, last_loaded_at, next_run_at, last_run_at, last_run_status, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           status = excluded.status,
           active_version_hash = excluded.active_version_hash,
           source_path = excluded.source_path,
           last_loaded_at = excluded.last_loaded_at,
           next_run_at = excluded.next_run_at,
           last_run_at = excluded.last_run_at,
           last_run_status = excluded.last_run_status,
           last_error = excluded.last_error`,
      )
      .run(
        state.name,
        state.status,
        state.activeVersionHash,
        state.sourcePath,
        state.lastLoadedAt,
        state.nextRunAt,
        state.lastRunAt,
        state.lastRunStatus,
        state.lastError,
      );
  }

  async listStates(): Promise<WorkflowState[]> {
    return this.db
      .query<StateRow, []>("SELECT * FROM workflow_states ORDER BY name")
      .all()
      .map(stateFromRow);
  }

  async createRun(run: WorkflowRun): Promise<void> {
    await this.updateRun(run);
  }

  async updateRun(run: WorkflowRun): Promise<void> {
    this.db
      .query(
        `INSERT INTO workflow_runs
         (id, workflow_name, workflow_version_hash, source_path, reason, actor_slack_user_id, status, started_at, finished_at, artifact_path, slack_channel, slack_thread_ts, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           finished_at = excluded.finished_at,
           slack_channel = excluded.slack_channel,
           slack_thread_ts = excluded.slack_thread_ts,
           error = excluded.error`,
      )
      .run(
        run.id,
        run.workflowName,
        run.workflowVersionHash,
        run.sourcePath,
        run.reason,
        run.actorSlackUserId,
        run.status,
        run.startedAt,
        run.finishedAt,
        run.artifactPath,
        run.slackChannel,
        run.slackThreadTs,
        run.error,
      );
  }

  async getRun(id: string): Promise<WorkflowRun | undefined> {
    const row = this.db
      .query<RunRow, [string]>("SELECT * FROM workflow_runs WHERE id = ?")
      .get(id);
    return row ? runFromRow(row) : undefined;
  }

  async listRuns(name: string, limit = 10): Promise<WorkflowRun[]> {
    return this.db
      .query<RunRow, [string, number]>(
        "SELECT * FROM workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(name, limit)
      .map(runFromRow);
  }
}

interface StateRow {
  name: string;
  status: WorkflowState["status"];
  active_version_hash: string;
  source_path: string;
  last_loaded_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: WorkflowLastRunStatus | null;
  last_error: string | null;
}

interface RunRow {
  id: string;
  workflow_name: string;
  workflow_version_hash: string;
  source_path: string;
  reason: WorkflowRun["reason"];
  actor_slack_user_id: string | null;
  status: WorkflowRunStatus;
  started_at: number;
  finished_at: number | null;
  artifact_path: string;
  slack_channel: string | null;
  slack_thread_ts: string | null;
  error: string | null;
}

function stateFromRow(row: StateRow): WorkflowState {
  return {
    name: row.name,
    status: row.status,
    activeVersionHash: row.active_version_hash,
    sourcePath: row.source_path,
    lastLoadedAt: row.last_loaded_at,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastError: row.last_error,
  };
}

function runFromRow(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    workflowVersionHash: row.workflow_version_hash,
    sourcePath: row.source_path,
    reason: row.reason,
    actorSlackUserId: row.actor_slack_user_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    artifactPath: row.artifact_path,
    slackChannel: row.slack_channel,
    slackThreadTs: row.slack_thread_ts,
    error: row.error,
  };
}
