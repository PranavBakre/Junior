import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DashboardAuditEntry,
  DashboardAuditRecordInput,
  DashboardAuditStore,
} from "./interface.ts";

type AuditRow = {
  id: string;
  at: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  request_json: string;
  result: string;
  error: string | null;
  slack_ts: string | null;
  commit_sha: string | null;
};

export class SqliteDashboardAuditStore implements DashboardAuditStore {
  private db: Database;
  private ownsDb: boolean;

  constructor(dbPathOrDb: string | Database) {
    if (typeof dbPathOrDb === "string") {
      mkdirSync(dirname(dbPathOrDb), { recursive: true });
      this.db = new Database(dbPathOrDb);
      this.ownsDb = true;
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = NORMAL");
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.migrate();
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  async record(entry: DashboardAuditRecordInput): Promise<DashboardAuditEntry> {
    const stored: DashboardAuditEntry = {
      id: entry.id ?? crypto.randomUUID(),
      at: entry.at ?? Date.now(),
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      request: entry.request ?? {},
      result: entry.result,
      error: entry.error ?? null,
      slackTs: entry.slackTs ?? null,
      commitSha: entry.commitSha ?? null,
    };
    this.db
      .query(
        `INSERT INTO dashboard_audit (
          id, at, actor, action, target_type, target_id,
          request_json, result, error, slack_ts, commit_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stored.id,
        stored.at,
        stored.actor,
        stored.action,
        stored.targetType,
        stored.targetId,
        JSON.stringify(stored.request),
        stored.result,
        stored.error,
        stored.slackTs,
        stored.commitSha,
      );
    return stored;
  }

  async list(filter: {
    action?: string;
    targetType?: string;
    from?: number;
    to?: number;
    limit?: number;
  } = {}): Promise<DashboardAuditEntry[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.action != null) {
      clauses.push("action = ?");
      params.push(filter.action);
    }
    if (filter.targetType != null) {
      clauses.push("target_type = ?");
      params.push(filter.targetType);
    }
    if (filter.from != null) {
      clauses.push("at >= ?");
      params.push(filter.from);
    }
    if (filter.to != null) {
      clauses.push("at <= ?");
      params.push(filter.to);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 100, 500);
    params.push(limit);
    const rows = this.db
      .query<AuditRow, Array<string | number>>(
        `SELECT * FROM dashboard_audit ${where} ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(...params);
    return rows.map(rowToEntry);
  }

  async count(filter: {
    action?: string;
    targetType?: string;
    from?: number;
    to?: number;
  } = {}): Promise<number> {
    const { where, params } = auditWhere(filter);
    const row = this.db
      .query<{ count: number }, Array<string | number>>(
        `SELECT COUNT(*) AS count FROM dashboard_audit ${where}`,
      )
      .get(...params);
    return row?.count ?? 0;
  }

  async deleteOlderThan(at: number): Promise<number> {
    const result = this.db
      .query("DELETE FROM dashboard_audit WHERE at < ?")
      .run(at);
    return result.changes;
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dashboard_audit (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result TEXT NOT NULL,
        error TEXT,
        slack_ts TEXT,
        commit_sha TEXT
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS dashboard_audit_at_idx
        ON dashboard_audit (at DESC)
    `);
  }
}

function auditWhere(filter: {
  action?: string;
  targetType?: string;
  from?: number;
  to?: number;
}): { where: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.action != null) {
    clauses.push("action = ?");
    params.push(filter.action);
  }
  if (filter.targetType != null) {
    clauses.push("target_type = ?");
    params.push(filter.targetType);
  }
  if (filter.from != null) {
    clauses.push("at >= ?");
    params.push(filter.from);
  }
  if (filter.to != null) {
    clauses.push("at <= ?");
    params.push(filter.to);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function rowToEntry(row: AuditRow): DashboardAuditEntry {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    request: parseRequest(row.request_json),
    result: row.result,
    error: row.error,
    slackTs: row.slack_ts,
    commitSha: row.commit_sha,
  };
}

function parseRequest(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
