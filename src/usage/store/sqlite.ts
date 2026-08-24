import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { mergeUsage } from "../merge.ts";
import type { NormalizedUsage, UsageEvent, UsageSourceKind } from "../normalize.ts";
import type { UsageBucket, UsageGroupBy, UsageGroupResult, UsageStore } from "./interface.ts";

type UsageRow = {
  id: string;
  source_kind: string;
  source_id: string;
  thread_id: string | null;
  channel_id: string | null;
  agent_name: string | null;
  provider: string | null;
  provider_session_id: string | null;
  pipeline_run_id: string | null;
  assignment_id: string | null;
  workflow_name: string | null;
  workflow_run_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_estimated_usd: number | null;
  num_turns: number | null;
  raw_json: string;
  occurred_at: number;
};

export class SqliteUsageStore implements UsageStore {
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

  async add(usage: NormalizedUsage): Promise<UsageEvent> {
    return this.db.transaction(() => {
      const existing = this.getSync(usage.sourceKind, usage.sourceId);
      const stored = existing
        ? mergeUsage(existing, usage)
        : { id: crypto.randomUUID(), ...usage };
      this.db
        .query(
          `INSERT INTO usage_events (
            id, source_kind, source_id, thread_id, channel_id, agent_name,
            provider, provider_session_id, pipeline_run_id, assignment_id,
            workflow_name, workflow_run_id, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, total_tokens, cost_usd,
            cost_estimated_usd, num_turns, raw_json, occurred_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
          ON CONFLICT(source_kind, source_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            channel_id = excluded.channel_id,
            agent_name = excluded.agent_name,
            provider = excluded.provider,
            provider_session_id = excluded.provider_session_id,
            pipeline_run_id = excluded.pipeline_run_id,
            assignment_id = excluded.assignment_id,
            workflow_name = excluded.workflow_name,
            workflow_run_id = excluded.workflow_run_id,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            cache_write_tokens = excluded.cache_write_tokens,
            total_tokens = excluded.total_tokens,
            cost_usd = excluded.cost_usd,
            cost_estimated_usd = excluded.cost_estimated_usd,
            num_turns = excluded.num_turns,
            raw_json = excluded.raw_json,
            occurred_at = excluded.occurred_at`,
        )
        .run(
          stored.id,
          stored.sourceKind,
          stored.sourceId,
          stored.threadId,
          stored.channelId,
          stored.agentName,
          stored.provider,
          stored.providerSessionId,
          stored.pipelineRunId,
          stored.assignmentId,
          stored.workflowName,
          stored.workflowRunId,
          stored.inputTokens,
          stored.outputTokens,
          stored.cacheReadTokens,
          stored.cacheWriteTokens,
          stored.totalTokens,
          stored.costUsd,
          stored.costEstimatedUsd,
          stored.numTurns,
          JSON.stringify(stored.raw),
          stored.occurredAt,
        );
      return stored;
    })();
  }

  async get(
    sourceKind: UsageSourceKind,
    sourceId: string,
  ): Promise<UsageEvent | undefined> {
    return this.getSync(sourceKind, sourceId);
  }

  async list(filter: {
    from?: number;
    to?: number;
    threadId?: string;
    sourceKind?: UsageSourceKind;
    limit?: number;
  } = {}): Promise<UsageEvent[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.from != null) {
      clauses.push("occurred_at >= ?");
      params.push(filter.from);
    }
    if (filter.to != null) {
      clauses.push("occurred_at <= ?");
      params.push(filter.to);
    }
    if (filter.threadId != null) {
      clauses.push("thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.sourceKind != null) {
      clauses.push("source_kind = ?");
      params.push(filter.sourceKind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit != null ? " LIMIT ?" : "";
    if (filter.limit != null) params.push(filter.limit);
    const rows = this.db
      .query<UsageRow, Array<string | number>>(
        `SELECT * FROM usage_events ${where} ORDER BY occurred_at DESC, id ASC${limit}`,
      )
      .all(...params);
    return rows.map(rowToEvent);
  }

  async groupBy(input: {
    from: number;
    to: number;
    groupBy: UsageGroupBy;
  }): Promise<UsageGroupResult> {
    const group = usageGroupExpression(input.groupBy, input.from, input.to);
    const totals = this.db.query<{
      turns: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      missingUsageTurns: number;
    }, [number, number]>(
      `SELECT COUNT(*) AS turns,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(cost_usd), 0) AS costUsd,
              COALESCE(SUM(CASE WHEN input_tokens IS NULL
                           AND output_tokens IS NULL
                           AND cache_read_tokens IS NULL
                           AND cache_write_tokens IS NULL
                           AND cost_usd IS NULL
                       THEN 1 ELSE 0 END), 0) AS missingUsageTurns
       FROM usage_events
       WHERE occurred_at >= ? AND occurred_at <= ?`,
    ).get(input.from, input.to) ?? {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      missingUsageTurns: 0,
    };
    const rows = this.db.query<{
      key: string;
      turns: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }, number[]>(
      `SELECT ${group.sql} AS key,
              COUNT(*) AS turns,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM usage_events
       WHERE occurred_at >= ? AND occurred_at <= ?
       GROUP BY ${group.sql}`,
    ).all(...group.params, input.from, input.to, ...group.params);
    return {
      totals: { ...totals, costEstimatedUsd: 0 },
      buckets: rows
        .map((row) => ({
          key: row.key,
          label: row.key,
          turns: row.turns,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: row.costUsd,
          costEstimatedUsd: 0,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  async count(filter: {
    from?: number;
    to?: number;
    threadId?: string;
    sourceKind?: UsageSourceKind;
  } = {}): Promise<number> {
    const { where, params } = usageWhere(filter);
    const row = this.db
      .query<{ count: number }, Array<string | number>>(
        `SELECT COUNT(*) AS count FROM usage_events ${where}`,
      )
      .get(...params);
    return row?.count ?? 0;
  }

  async summarizeByThread(threadIds: string[]): Promise<UsageBucket[]> {
    const unique = [...new Set(threadIds)];
    if (unique.length === 0) return [];
    const byThread = new Map<string, UsageBucket>();
    const chunkSize = 400;
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .query<
          {
            key: string;
            turns: number;
            inputTokens: number;
            outputTokens: number;
            costUsd: number;
          },
          string[]
        >(
          `SELECT thread_id AS key,
                  COUNT(*) AS turns,
                  COALESCE(SUM(input_tokens), 0) AS inputTokens,
                  COALESCE(SUM(output_tokens), 0) AS outputTokens,
                  COALESCE(SUM(cost_usd), 0) AS costUsd
           FROM usage_events
           WHERE thread_id IN (${placeholders})
           GROUP BY thread_id`,
        )
        .all(...chunk);
      for (const row of rows) {
        byThread.set(row.key, {
          key: row.key,
          label: row.key,
          turns: row.turns,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: row.costUsd,
          costEstimatedUsd: 0,
        });
      }
    }
    return unique.map((threadId) =>
      byThread.get(threadId) ?? {
        key: threadId,
        label: threadId,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costEstimatedUsd: 0,
      },
    );
  }

  async deleteOlderThan(occurredAt: number): Promise<number> {
    const result = this.db
      .query("DELETE FROM usage_events WHERE occurred_at < ?")
      .run(occurredAt);
    return result.changes;
  }

  private getSync(
    sourceKind: UsageSourceKind,
    sourceId: string,
  ): UsageEvent | undefined {
    const row = this.db
      .query<UsageRow, [string, string]>(
        "SELECT * FROM usage_events WHERE source_kind = ? AND source_id = ?",
      )
      .get(sourceKind, sourceId);
    return row ? rowToEvent(row) : undefined;
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id                TEXT PRIMARY KEY,
        source_kind       TEXT NOT NULL,
        source_id         TEXT NOT NULL,
        thread_id         TEXT,
        channel_id        TEXT,
        agent_name        TEXT,
        provider          TEXT,
        provider_session_id TEXT,
        pipeline_run_id   TEXT,
        assignment_id     TEXT,
        workflow_name     TEXT,
        workflow_run_id   TEXT,
        input_tokens      INTEGER,
        output_tokens     INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens      INTEGER,
        cost_usd          REAL,
        cost_estimated_usd REAL,
        num_turns         INTEGER,
        raw_json          TEXT NOT NULL,
        occurred_at       INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS usage_events_source_uidx
        ON usage_events (source_kind, source_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS usage_events_occurred_idx
        ON usage_events (occurred_at)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS usage_events_thread_idx
        ON usage_events (thread_id, occurred_at)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS usage_events_pipeline_idx
        ON usage_events (pipeline_run_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS usage_events_workflow_idx
        ON usage_events (workflow_name, occurred_at)
    `);
  }
}

function usageGroupExpression(
  groupBy: UsageGroupBy,
  from: number,
  to: number,
): { sql: string; params: number[] } {
  switch (groupBy) {
    case "day": return localDaySqlExpression(from, to);
    case "session": return { sql: "COALESCE(thread_id, 'unknown')", params: [] };
    case "agent": return { sql: "COALESCE(agent_name, 'unknown')", params: [] };
    case "provider": return { sql: "COALESCE(provider, 'unknown')", params: [] };
    case "workflow": return { sql: "COALESCE(workflow_name, workflow_run_id, 'unknown')", params: [] };
    case "pipeline": return { sql: "COALESCE(pipeline_run_id, 'unknown')", params: [] };
  }
}

function localDaySqlExpression(from: number, to: number): { sql: string; params: number[] } {
  const segments = timezoneSegments(from, to);
  const params: number[] = [];
  const cases = segments.map((segment) => {
    params.push(segment.from, segment.toExclusive);
    return `WHEN occurred_at >= ? AND occurred_at < ? THEN strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch', ${timezoneModifier(segment.offsetMinutes)})`;
  });
  return {
    sql: `(CASE ${cases.join(" ")} ELSE strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch') END)`,
    params,
  };
}

type TimezoneSegment = { from: number; toExclusive: number; offsetMinutes: number };

function timezoneSegments(from: number, to: number): TimezoneSegment[] {
  const end = to + 1;
  const segments: TimezoneSegment[] = [];
  let cursor = from;
  while (cursor < end) {
    const offset = new Date(cursor).getTimezoneOffset();
    let probe = Math.min(cursor + 24 * 60 * 60 * 1000, end);
    while (probe < end && new Date(probe).getTimezoneOffset() === offset) {
      probe = Math.min(probe + 24 * 60 * 60 * 1000, end);
    }
    let transition = probe;
    if (probe < end) {
      let low = cursor;
      let high = probe;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (new Date(middle).getTimezoneOffset() === offset) low = middle;
        else high = middle;
      }
      transition = high;
    }
    segments.push({ from: cursor, toExclusive: transition, offsetMinutes: offset });
    cursor = transition;
  }
  return segments;
}

function timezoneModifier(offsetMinutes: number): string {
  const eastMinutes = -offsetMinutes;
  const sign = eastMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(eastMinutes);
  const hours = `'${sign}${Math.floor(absolute / 60)} hours'`;
  return absolute % 60 ? `${hours}, '${sign}${absolute % 60} minutes'` : hours;
}

function usageWhere(filter: {
  from?: number;
  to?: number;
  threadId?: string;
  sourceKind?: UsageSourceKind;
}): { where: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.from != null) {
    clauses.push("occurred_at >= ?");
    params.push(filter.from);
  }
  if (filter.to != null) {
    clauses.push("occurred_at <= ?");
    params.push(filter.to);
  }
  if (filter.threadId != null) {
    clauses.push("thread_id = ?");
    params.push(filter.threadId);
  }
  if (filter.sourceKind != null) {
    clauses.push("source_kind = ?");
    params.push(filter.sourceKind);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function rowToEvent(row: UsageRow): UsageEvent {
  return {
    id: row.id,
    sourceKind: row.source_kind as UsageSourceKind,
    sourceId: row.source_id,
    threadId: row.thread_id,
    channelId: row.channel_id,
    agentName: row.agent_name,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    pipelineRunId: row.pipeline_run_id,
    assignmentId: row.assignment_id,
    workflowName: row.workflow_name,
    workflowRunId: row.workflow_run_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    costEstimatedUsd: null,
    numTurns: row.num_turns,
    raw: parseRaw(row.raw_json),
    occurredAt: row.occurred_at,
  };
}

function parseRaw(rawJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
