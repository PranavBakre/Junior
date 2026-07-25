import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  cosineSim,
  deserializeEmbedding,
  serializeEmbedding,
} from "../../memory/sqlite.ts";
import type { TaskRouteStore } from "./interface.ts";
import type {
  RouteFetchBookkeeping,
  RouteIdentity,
  RouteRecallOptions,
  RouteRecallResult,
  TaskRouteRecord,
  TaskRouteStepRecord,
  TaskRouteUpsert,
} from "../types.ts";

type RouteRow = {
  id: string;
  repo: string;
  feature: string;
  task_kind: string;
  task_desc: string;
  embedding: Uint8Array | null;
  embed_model: string | null;
  dim: number | null;
  verified_sha: string;
  fetch_count: number | null;
  repair_count: number | null;
  broken_fetches: number | null;
  created_at: number;
  last_used_at: number | null;
  active: number | null;
};

type StepRow = {
  route_id: string;
  ord: number;
  note: string;
  path: string | null;
  symbol: string | null;
  decl_pattern: string | null;
  sig_hash: string | null;
  block_hash: string | null;
  expects_ref: string | null;
  touch_count: number | null;
};

/**
 * Task routes in the same SQLite file as memory v3 (`MEMORY_DB_PATH`). New
 * tables rather than a new claim kind: a claim is one atomic text plus one
 * embedding, and `claim.kind` carries a SQL CHECK that SQLite cannot ALTER.
 */
export class SqliteTaskRouteStore implements TaskRouteStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Upsert on the unique `(repo, feature, task_kind)` identity in ONE
   * transaction with the step rows — a save is atomic or it did not happen.
   *
   * `id` is deliberately not in the DO UPDATE set: the pre-existing row keeps
   * its primary key so step rows and any external reference stay valid, and an
   * ARCHIVED row is revived in place rather than sitting alongside a new one
   * (archived rows still occupy the identity). `fetch_count` / `repair_count`
   * are history of the identity and survive an overwrite; `touch_count` does
   * not, because the new step list renumbers what each ord means.
   */
  async upsertRoute(route: TaskRouteUpsert): Promise<TaskRouteRecord> {
    const dim = route.dim ?? (route.embedding ? route.embedding.length : null);
    const txn = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO task_route (
            id, repo, feature, task_kind, task_desc, embedding, embed_model, dim,
            verified_sha, fetch_count, repair_count, broken_fetches, created_at,
            last_used_at, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, NULL, ?)
          ON CONFLICT(repo, feature, task_kind) DO UPDATE SET
            task_desc = excluded.task_desc,
            embedding = excluded.embedding,
            embed_model = excluded.embed_model,
            dim = excluded.dim,
            verified_sha = excluded.verified_sha,
            broken_fetches = 0,
            active = excluded.active`,
        )
        .run(
          route.id,
          route.repo,
          route.feature,
          route.taskKind,
          route.taskDesc,
          route.embedding ? serializeEmbedding(route.embedding) : null,
          route.embedModel ?? null,
          dim,
          route.verifiedSha,
          route.createdAt,
          route.active === false ? 0 : 1,
        );
      const stored = this.db
        .query<{ id: string }, [string, string, string]>(
          "SELECT id FROM task_route WHERE repo = ? AND feature = ? AND task_kind = ?",
        )
        .get(route.repo, route.feature, route.taskKind);
      const routeId = stored?.id ?? route.id;
      this.db.query("DELETE FROM task_route_step WHERE route_id = ?").run(routeId);
      const insert = this.db.query(
        `INSERT INTO task_route_step (
          route_id, ord, note, path, symbol, decl_pattern, sig_hash, block_hash,
          expects_ref, touch_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const step of route.steps) {
        insert.run(
          routeId,
          step.ord,
          step.note,
          step.path ?? null,
          step.symbol ?? null,
          step.declPattern ?? null,
          step.sigHash ?? null,
          step.blockHash ?? null,
          step.expectsRef ?? null,
          step.touchCount,
        );
      }
      return routeId;
    });
    const routeId = txn();
    const record = await this.getRoute(routeId);
    if (!record) throw new Error(`task route ${routeId} vanished during upsert`);
    return record;
  }

  async getRoute(id: string): Promise<TaskRouteRecord | null> {
    const row = this.db
      .query<RouteRow, [string]>(`${SELECT_ROUTE} WHERE id = ?`)
      .get(id);
    return row ? this.hydrate(row) : null;
  }

  async getRouteByIdentity(
    repo: string,
    feature: string,
    taskKind: string,
  ): Promise<TaskRouteRecord | null> {
    const row = this.db
      .query<RouteRow, [string, string, string]>(
        `${SELECT_ROUTE} WHERE repo = ? AND feature = ? AND task_kind = ?`,
      )
      .get(repo, feature, taskKind);
    return row ? this.hydrate(row) : null;
  }

  /**
   * SQL WHERE for the scalar filters, then cosine in TypeScript over the
   * deserialized BLOBs — the same brute-force shape `recallClaims` uses. The
   * corpus is one route per identity (dozens to low hundreds), so a vector
   * index would buy nothing here.
   */
  async recallRoutes(options: RouteRecallOptions): Promise<RouteRecallResult[]> {
    const limit = options.limit ?? 5;
    const where = ["active = 1", "repo = ?"];
    const params: string[] = [options.repo];
    if (options.feature) {
      where.push("feature = ?");
      params.push(options.feature);
    }
    const rows = this.db
      .query<RouteRow, string[]>(`${SELECT_ROUTE} WHERE ${where.join(" AND ")}`)
      .all(...params);

    const scored = rows.map((row) => {
      const vector = deserializeEmbedding(row.embedding);
      const cosine =
        options.queryVector && vector ? cosineSim(options.queryVector, vector) : null;
      return { row, cosine };
    });
    scored.sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0));
    return scored.slice(0, limit).map((entry) => ({
      route: this.hydrate(entry.row),
      cosine: entry.cosine,
    }));
  }

  async listRouteIdentities(repo: string, limit = 25): Promise<RouteIdentity[]> {
    return this.db
      .query<{ feature: string; task_kind: string; active: number | null }, [string, number]>(
        // TEXT columns default to BINARY collation here, which the in-memory
        // store mirrors with `<`/`>` rather than `localeCompare`.
        `SELECT feature, task_kind, active FROM task_route
         WHERE repo = ? ORDER BY feature ASC, task_kind ASC LIMIT ?`,
      )
      .all(repo, limit)
      .map((row) => ({
        feature: row.feature,
        taskKind: row.task_kind,
        active: (row.active ?? 1) === 1,
      }));
  }

  async recordFetch(routeId: string, book: RouteFetchBookkeeping): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE task_route
           SET fetch_count = fetch_count + 1,
               last_used_at = ?,
               repair_count = repair_count + ?,
               broken_fetches = ?
           WHERE id = ?`,
        )
        .run(book.now, book.repairs.length, book.brokenFetches, routeId);
      if (book.verifiedSha) {
        this.db
          .query("UPDATE task_route SET verified_sha = ? WHERE id = ?")
          .run(book.verifiedSha, routeId);
      }
      if (book.active !== undefined) {
        this.db
          .query("UPDATE task_route SET active = ? WHERE id = ?")
          .run(book.active ? 1 : 0, routeId);
      }
      const repair = this.db.query(
        `UPDATE task_route_step
         SET path = ?, decl_pattern = ?, sig_hash = ?, block_hash = ?
         WHERE route_id = ? AND ord = ?`,
      );
      for (const fix of book.repairs) {
        repair.run(
          fix.path,
          fix.declPattern,
          fix.sigHash,
          fix.blockHash,
          routeId,
          fix.ord,
        );
      }
    });
    txn();
  }

  async recordUsage(routeId: string, ords: number[]): Promise<number> {
    const unique = [...new Set(ords)];
    if (unique.length === 0) return 0;
    let updated = 0;
    const exists = this.db.query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM task_route_step WHERE route_id = ? AND ord = ?",
    );
    const bump = this.db.query(
      "UPDATE task_route_step SET touch_count = touch_count + 1 WHERE route_id = ? AND ord = ?",
    );
    const txn = this.db.transaction(() => {
      for (const ord of unique) {
        if ((exists.get(routeId, ord)?.n ?? 0) === 0) continue;
        bump.run(routeId, ord);
        updated += 1;
      }
    });
    txn();
    return updated;
  }

  private hydrate(row: RouteRow): TaskRouteRecord {
    const steps = this.db
      .query<StepRow, [string]>(
        `SELECT route_id, ord, note, path, symbol, decl_pattern, sig_hash, block_hash,
                expects_ref, touch_count
         FROM task_route_step WHERE route_id = ? ORDER BY ord ASC`,
      )
      .all(row.id)
      .map(toStepRecord);
    return {
      id: row.id,
      repo: row.repo,
      feature: row.feature,
      taskKind: row.task_kind,
      taskDesc: row.task_desc,
      verifiedSha: row.verified_sha,
      fetchCount: row.fetch_count ?? 0,
      repairCount: row.repair_count ?? 0,
      brokenFetches: row.broken_fetches ?? 0,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      active: (row.active ?? 1) === 1,
      steps,
    };
  }

  private migrate(): void {
    this.db.run(
      `CREATE TABLE IF NOT EXISTS task_route (id TEXT PRIMARY KEY, repo TEXT NOT NULL, feature TEXT NOT NULL, task_kind TEXT NOT NULL, task_desc TEXT NOT NULL, embedding BLOB, embed_model TEXT, dim INTEGER, verified_sha TEXT NOT NULL, fetch_count INTEGER DEFAULT 0, repair_count INTEGER DEFAULT 0, broken_fetches INTEGER DEFAULT 0, created_at INTEGER NOT NULL, last_used_at INTEGER, active INTEGER DEFAULT 1)`,
    );
    this.db.run(
      `CREATE TABLE IF NOT EXISTS task_route_step (route_id TEXT NOT NULL, ord INTEGER NOT NULL, note TEXT NOT NULL, path TEXT, symbol TEXT, decl_pattern TEXT, sig_hash TEXT, block_hash TEXT, expects_ref TEXT, touch_count INTEGER DEFAULT 0, PRIMARY KEY (route_id, ord))`,
    );
    // Load-bearing, not decoration: without it a concurrent or interrupted save
    // inserts a second route for the same identity and defeats the single-route
    // guarantee. It is also the ON CONFLICT target the upsert names.
    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS task_route_identity ON task_route (repo, feature, task_kind)",
    );
    this.db.run("CREATE INDEX IF NOT EXISTS task_route_repo_idx ON task_route (repo, active)");
  }
}

const SELECT_ROUTE = `SELECT id, repo, feature, task_kind, task_desc, embedding, embed_model, dim,
       verified_sha, fetch_count, repair_count, broken_fetches, created_at, last_used_at, active
FROM task_route`;

function toStepRecord(row: StepRow): TaskRouteStepRecord {
  return {
    ord: row.ord,
    note: row.note,
    path: row.path,
    symbol: row.symbol,
    declPattern: row.decl_pattern,
    sigHash: row.sig_hash,
    blockHash: row.block_hash,
    expectsRef: row.expects_ref,
    touchCount: row.touch_count ?? 0,
  };
}
