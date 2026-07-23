import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CatalogEntry {
  kind: "runbook" | "agent";
  name: string;
  repo: string;
  path: string;
  commitSha: string;
  contentDigest: string;
  schemaVersion: number;
  enabled: boolean;
  loadedAt: number;
  validationStatus: "valid" | "invalid" | "unknown";
  validationErrors: string | null;
}

export interface DefinitionRun {
  id: string;
  kind: "runbook";
  name: string;
  versionDigest: string;
  ownerAgent: string;
  intentFingerprint: string;
  risk: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  approvalRef: string | null;
  evidenceRefs: string | null;
}

export interface DefinitionEvaluation {
  id: string;
  kind: "runbook";
  name: string;
  versionDigest: string;
  fixture: string;
  expectedRoute: boolean;
  actualRoute: boolean;
  passed: boolean;
  evaluatedAt: number;
}

export class CatalogStore {
  private db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS definition_catalog (
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        repo TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '',
        commit_sha TEXT NOT NULL DEFAULT '',
        content_digest TEXT NOT NULL DEFAULT '',
        schema_version INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        loaded_at INTEGER NOT NULL,
        validation_status TEXT NOT NULL DEFAULT 'unknown',
        validation_errors TEXT,
        PRIMARY KEY (kind, name)
      );

      CREATE TABLE IF NOT EXISTS definition_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'runbook',
        name TEXT NOT NULL,
        version_digest TEXT NOT NULL,
        owner_agent TEXT NOT NULL,
        intent_fingerprint TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        approval_ref TEXT,
        evidence_refs TEXT
      );

      CREATE TABLE IF NOT EXISTS definition_evaluations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'runbook',
        name TEXT NOT NULL,
        version_digest TEXT NOT NULL,
        fixture TEXT NOT NULL,
        expected_route INTEGER NOT NULL,
        actual_route INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        evaluated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS promotion_candidates (
        fingerprint TEXT PRIMARY KEY,
        proposed_kind TEXT NOT NULL,
        normalized_intent TEXT NOT NULL DEFAULT '',
        owner_agent TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        successful_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        procedure_memory_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'tracking',
        risk TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  upsertCatalogEntry(entry: CatalogEntry): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO definition_catalog
         (kind, name, repo, path, commit_sha, content_digest, schema_version, enabled, loaded_at, validation_status, validation_errors)
         VALUES ($kind, $name, $repo, $path, $commitSha, $contentDigest, $schemaVersion, $enabled, $loadedAt, $validationStatus, $validationErrors)`,
      )
      .run({
        $kind: entry.kind,
        $name: entry.name,
        $repo: entry.repo,
        $path: entry.path,
        $commitSha: entry.commitSha,
        $contentDigest: entry.contentDigest,
        $schemaVersion: entry.schemaVersion,
        $enabled: entry.enabled ? 1 : 0,
        $loadedAt: entry.loadedAt,
        $validationStatus: entry.validationStatus,
        $validationErrors: entry.validationErrors,
      });
  }

  getCatalogEntry(kind: string, name: string): CatalogEntry | null {
    const row = this.db
      .query(
        `SELECT * FROM definition_catalog WHERE kind = $kind AND name = $name`,
      )
      .get({ $kind: kind, $name: name }) as CatalogEntryRow | null;
    return row ? rowToCatalogEntry(row) : null;
  }

  listCatalogEntries(kind?: string): CatalogEntry[] {
    const rows = kind
      ? (this.db
          .query(`SELECT * FROM definition_catalog WHERE kind = $kind ORDER BY name`)
          .all({ $kind: kind }) as CatalogEntryRow[])
      : (this.db
          .query(`SELECT * FROM definition_catalog ORDER BY name`)
          .all() as CatalogEntryRow[]);
    return rows.map(rowToCatalogEntry);
  }

  deactivateEntry(kind: string, name: string): boolean {
    const result = this.db
      .query(
        `UPDATE definition_catalog SET enabled = 0 WHERE kind = $kind AND name = $name`,
      )
      .run({ $kind: kind, $name: name });
    return result.changes > 0;
  }

  insertRun(run: DefinitionRun): void {
    this.db
      .query(
        `INSERT INTO definition_runs
         (id, kind, name, version_digest, owner_agent, intent_fingerprint, risk, status, started_at, completed_at, approval_ref, evidence_refs)
         VALUES ($id, $kind, $name, $versionDigest, $ownerAgent, $intentFingerprint, $risk, $status, $startedAt, $completedAt, $approvalRef, $evidenceRefs)`,
      )
      .run({
        $id: run.id,
        $kind: run.kind,
        $name: run.name,
        $versionDigest: run.versionDigest,
        $ownerAgent: run.ownerAgent,
        $intentFingerprint: run.intentFingerprint,
        $risk: run.risk,
        $status: run.status,
        $startedAt: run.startedAt,
        $completedAt: run.completedAt,
        $approvalRef: run.approvalRef,
        $evidenceRefs: run.evidenceRefs,
      });
  }

  updateRunStatus(id: string, status: string, completedAt?: number): void {
    this.db
      .query(
        `UPDATE definition_runs SET status = $status, completed_at = $completedAt WHERE id = $id`,
      )
      .run({ $id: id, $status: status, $completedAt: completedAt ?? null });
  }

  getRunsByName(name: string): DefinitionRun[] {
    return this.db
      .query(
        `SELECT * FROM definition_runs WHERE name = $name ORDER BY started_at DESC`,
      )
      .all({ $name: name }) as DefinitionRun[];
  }

  getRunsByDigest(versionDigest: string): DefinitionRun[] {
    return this.db
      .query(
        `SELECT * FROM definition_runs WHERE version_digest = $digest ORDER BY started_at DESC`,
      )
      .all({ $digest: versionDigest }) as DefinitionRun[];
  }

  insertEvaluation(evaluation: DefinitionEvaluation): void {
    this.db
      .query(
        `INSERT INTO definition_evaluations
         (id, kind, name, version_digest, fixture, expected_route, actual_route, passed, evaluated_at)
         VALUES ($id, $kind, $name, $versionDigest, $fixture, $expectedRoute, $actualRoute, $passed, $evaluatedAt)`,
      )
      .run({
        $id: evaluation.id,
        $kind: evaluation.kind,
        $name: evaluation.name,
        $versionDigest: evaluation.versionDigest,
        $fixture: evaluation.fixture,
        $expectedRoute: evaluation.expectedRoute ? 1 : 0,
        $actualRoute: evaluation.actualRoute ? 1 : 0,
        $passed: evaluation.passed ? 1 : 0,
        $evaluatedAt: evaluation.evaluatedAt,
      });
  }

  getEvaluationsByName(name: string): DefinitionEvaluation[] {
    const rows = this.db
      .query(
        `SELECT * FROM definition_evaluations WHERE name = $name ORDER BY evaluated_at DESC`,
      )
      .all({ $name: name }) as EvaluationRow[];
    return rows.map(rowToEvaluation);
  }

  close(): void {
    this.db.close();
  }
}

type CatalogEntryRow = {
  kind: string;
  name: string;
  repo: string;
  path: string;
  commit_sha: string;
  content_digest: string;
  schema_version: number;
  enabled: number;
  loaded_at: number;
  validation_status: string;
  validation_errors: string | null;
};

function rowToCatalogEntry(row: CatalogEntryRow): CatalogEntry {
  return {
    kind: row.kind as CatalogEntry["kind"],
    name: row.name,
    repo: row.repo,
    path: row.path,
    commitSha: row.commit_sha,
    contentDigest: row.content_digest,
    schemaVersion: row.schema_version,
    enabled: row.enabled === 1,
    loadedAt: row.loaded_at,
    validationStatus: row.validation_status as CatalogEntry["validationStatus"],
    validationErrors: row.validation_errors,
  };
}

type EvaluationRow = {
  id: string;
  kind: string;
  name: string;
  version_digest: string;
  fixture: string;
  expected_route: number;
  actual_route: number;
  passed: number;
  evaluated_at: number;
};

function rowToEvaluation(row: EvaluationRow): DefinitionEvaluation {
  return {
    id: row.id,
    kind: row.kind as "runbook",
    name: row.name,
    versionDigest: row.version_digest,
    fixture: row.fixture,
    expectedRoute: row.expected_route === 1,
    actualRoute: row.actual_route === 1,
    passed: row.passed === 1,
    evaluatedAt: row.evaluated_at,
  };
}
