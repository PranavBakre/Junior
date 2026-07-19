import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  GitHubPollClass,
  GitHubResource,
  GitHubSemanticEvent,
  PipelineGitHubResource,
  PipelineGitHubResourceRole,
  PrSnapshot,
  ProposedReduction,
  ShadowPersistResult,
} from "../../github/types.ts";
import type { Clock } from "../../time/clock.ts";
import { systemClock } from "../../time/clock.ts";
import {
  canonicalizeRevisionMembers,
  computeRevisionDigest,
  revisionVectorChanged,
} from "../revision.ts";
import type {
  Assignment,
  AssignmentCreate,
  AttemptRevisionMember,
  BugPhase,
  BugRun,
  DevServerJob,
  DevServerJobCreate,
  DevServerJobStatus,
  OutboxCreate,
  PipelineAttempt,
  PipelineEvent,
  PipelineGate,
  PipelineOutboxRecord,
  PipelineRun,
  PipelineRunStatus,
  PipelineThreadCursor,
  ProductPhase,
  ProductRun,
  RecordOutcomeInput,
  StoredOutcome,
  TerminalOutcome,
  TransitionReceipt,
} from "../types.ts";
import type { PipelineStore } from "./interface.ts";
import { decideOutcomeTransaction } from "./outcome-tx.ts";
import {
  isTerminalDevServerStatus,
  releaseStatusForReason,
} from "../dev-server-jobs.ts";

type RunRow = {
  id: string;
  kind: string;
  definition_version: number;
  channel_id: string;
  thread_id: string;
  phase: string;
  status: string;
  owner_agent: string;
  repo_refs_json: string;
  acceptance_json: string;
  artifact_refs_json: string;
  blocker_refs_json: string;
  active_attempt_id: string | null;
  state_version: number;
  deadline_at: number | null;
  terminal_outcome: string | null;
  terminal_reason: string | null;
  created_at: number;
  updated_at: number;
};

type AssignmentRow = {
  id: string;
  run_id: string;
  parent_assignment_id: string | null;
  source_agent: string;
  target_agent: string;
  status: string;
  objective: string;
  context_refs_json: string;
  artifact_refs_json: string;
  acceptance_json: string;
  mutation_scope_json: string;
  dependencies_json: string;
  attempt_number: number;
  attempt_id: string | null;
  candidate_revision_digest: string | null;
  deadline_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
};

type OutcomeRow = {
  id: string;
  assignment_id: string;
  action: string;
  status: string;
  reason: string;
  evidence_refs_json: string;
  artifact_refs_json: string;
  blockers_json: string;
  checks_json: string;
  confidence: number | null;
  progress_fingerprint: string;
  created_at: number;
};

type EventRow = {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  actor_type: string;
  actor_id: string;
  assignment_id: string | null;
  outcome_id: string | null;
  from_phase: string | null;
  to_phase: string | null;
  payload_version: number;
  payload_json: string;
  idempotency_key: string | null;
  occurred_at: number;
  observed_at: number;
};

type OutboxRow = {
  id: string;
  run_id: string;
  assignment_id: string | null;
  event_type: string;
  payload_json: string;
  status: string;
  attempts: number;
  available_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  idempotency_key: string;
  created_at: number;
  delivered_at: number | null;
  last_error: string | null;
};

type AttemptRow = {
  id: string;
  run_id: string;
  ordinal: number;
  revision_digest: string | null;
  status: string;
  invalidated_at: number | null;
  invalidation_reason: string | null;
  created_at: number;
  finished_at: number | null;
};

type RevisionRow = {
  id: string;
  attempt_id: string;
  member_key: string;
  repo_ref: string;
  branch: string;
  head_sha: string;
  github_resource_id: string | null;
  created_at: number;
  updated_at: number;
};

type GateRow = {
  id: string;
  run_id: string;
  attempt_id: string;
  member_key: string | null;
  github_resource_id: string | null;
  gate_kind: string;
  status: string;
  subject_sha: string | null;
  evidence_ref: string | null;
  provider: string | null;
  model: string | null;
  agent_name: string | null;
  updated_at: number;
};

type GitHubResourceRow = {
  id: string;
  kind: string;
  owner: string;
  repo: string;
  number: number;
  node_id: string | null;
  snapshot_json: string | null;
  last_polled_at: number | null;
  next_poll_at: number;
  poll_class: string;
  consecutive_failures: number;
  last_error: string | null;
  lease_owner: string | null;
  lease_until: number | null;
  terminal_at: number | null;
  created_at: number;
  updated_at: number;
};

type PipelineGitHubResourceRow = {
  id: string;
  run_id: string;
  resource_id: string;
  role: string;
  workstream_key: string;
  attempt_id: string | null;
  registered_by_assignment_id: string | null;
  expected_head_sha: string | null;
  active: number;
  created_at: number;
  updated_at: number;
};

type DevServerJobRow = {
  id: string;
  run_id: string;
  assignment_id: string;
  channel_id: string;
  thread_id: string;
  repo: string;
  branch: string;
  status: string;
  ready_url: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  deadline_at: number;
  pid: number | null;
  error: string | null;
  released_at: number | null;
  release_reason: string | null;
  created_at: number;
  updated_at: number;
};

type ThreadCursorRow = {
  run_id: string;
  channel_id: string;
  thread_id: string;
  last_observed_ts: string;
  last_catchup_at: number | null;
  updated_at: number;
};

export class SqlitePipelineStore implements PipelineStore {
  private db: Database;
  private ownsDb: boolean;
  private clock: Clock;

  constructor(
    dbPathOrDb: string | Database,
    clock: Clock = systemClock,
  ) {
    this.clock = clock;
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
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('product', 'bug')),
        definition_version INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'needs-human', 'terminal')),
        owner_agent TEXT NOT NULL,
        repo_refs_json TEXT NOT NULL DEFAULT '[]',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        blocker_refs_json TEXT NOT NULL DEFAULT '[]',
        active_attempt_id TEXT,
        state_version INTEGER NOT NULL DEFAULT 0,
        deadline_at INTEGER,
        terminal_outcome TEXT,
        terminal_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_thread
      ON pipeline_runs (thread_id)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        revision_digest TEXT,
        status TEXT NOT NULL,
        invalidated_at INTEGER,
        invalidation_reason TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_attempt_revisions (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        member_key TEXT NOT NULL,
        repo_ref TEXT NOT NULL,
        branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        github_resource_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (attempt_id, member_key),
        FOREIGN KEY (attempt_id) REFERENCES pipeline_attempts(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_gates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        member_key TEXT,
        github_resource_id TEXT,
        gate_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        subject_sha TEXT,
        evidence_ref TEXT,
        provider TEXT,
        model TEXT,
        agent_name TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id),
        FOREIGN KEY (attempt_id) REFERENCES pipeline_attempts(id)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_gates_attempt
      ON pipeline_gates (attempt_id)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_assignments (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_assignment_id TEXT,
        source_agent TEXT NOT NULL,
        target_agent TEXT NOT NULL,
        status TEXT NOT NULL,
        objective TEXT NOT NULL,
        context_refs_json TEXT NOT NULL DEFAULT '[]',
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        mutation_scope_json TEXT NOT NULL DEFAULT '[]',
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        attempt_number INTEGER NOT NULL DEFAULT 1,
        attempt_id TEXT,
        candidate_revision_digest TEXT,
        deadline_at INTEGER,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_assignments_run
      ON pipeline_assignments (run_id)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_outcomes (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        checks_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL,
        progress_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (assignment_id) REFERENCES pipeline_assignments(id)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_outcomes_assignment
      ON pipeline_outcomes (assignment_id)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        assignment_id TEXT,
        outcome_id TEXT,
        from_phase TEXT,
        to_phase TEXT,
        payload_version INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT,
        occurred_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        UNIQUE (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
      )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_idempotency
      ON pipeline_events (idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_outbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        assignment_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        last_error TEXT,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_outbox_ready
      ON pipeline_outbox (status, available_at)
    `);

    // Phase 5: GitHub resource tracking (shadow reconciler)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS github_resources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'pull_request',
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        node_id TEXT,
        snapshot_json TEXT,
        last_polled_at INTEGER,
        next_poll_at INTEGER NOT NULL,
        poll_class TEXT NOT NULL DEFAULT 'hot',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lease_owner TEXT,
        lease_until INTEGER,
        terminal_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner, repo, number)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_github_resources_next_poll
      ON github_resources (next_poll_at)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_github_resources (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        role TEXT NOT NULL,
        workstream_key TEXT NOT NULL,
        attempt_id TEXT,
        registered_by_assignment_id TEXT,
        expected_head_sha TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, resource_id, role),
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id),
        FOREIGN KEY (resource_id) REFERENCES github_resources(id)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_github_resources_resource
      ON pipeline_github_resources (resource_id, active)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_github_resources_run
      ON pipeline_github_resources (run_id, active)
    `);

    // Phase 6: durable dev-server jobs
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dev_server_jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        ready_url TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        deadline_at INTEGER NOT NULL,
        pid INTEGER,
        error TEXT,
        released_at INTEGER,
        release_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (assignment_id),
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_dev_server_jobs_run
      ON dev_server_jobs (run_id, status)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_dev_server_jobs_status
      ON dev_server_jobs (status, deadline_at)
    `);

    // Phase 6: Slack thread catch-up cursors for waiting runs
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_thread_cursors (
        run_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        last_observed_ts TEXT NOT NULL,
        last_catchup_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_thread_cursors_thread
      ON pipeline_thread_cursors (thread_id)
    `);
  }

  async createRun(run: PipelineRun): Promise<void> {
    this.db
      .query(
        `INSERT INTO pipeline_runs (
          id, kind, definition_version, channel_id, thread_id,
          phase, status, owner_agent, repo_refs_json, acceptance_json,
          artifact_refs_json, blocker_refs_json, active_attempt_id,
          state_version, deadline_at, terminal_outcome, terminal_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.kind,
        run.definitionVersion,
        run.channelId,
        run.threadId,
        run.phase,
        run.status,
        run.ownerAgent,
        JSON.stringify(run.repoRefs),
        JSON.stringify(run.acceptanceCriteria),
        JSON.stringify(run.artifactRefs),
        JSON.stringify(run.blockerRefs),
        run.activeAttemptId,
        run.stateVersion,
        run.deadlineAt,
        run.terminalOutcome,
        run.terminalReason,
        run.createdAt,
        run.updatedAt,
      );
  }

  async getRun(id: string): Promise<PipelineRun | undefined> {
    const row = this.db
      .query<RunRow, [string]>("SELECT * FROM pipeline_runs WHERE id = ?")
      .get(id);
    return row ? runFromRow(row) : undefined;
  }

  async getRunByThread(threadId: string): Promise<PipelineRun | undefined> {
    const row = this.db
      .query<RunRow, [string]>(
        `SELECT * FROM pipeline_runs
         WHERE thread_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(threadId);
    return row ? runFromRow(row) : undefined;
  }

  async createAssignment(input: AssignmentCreate): Promise<Assignment> {
    const existing = this.db
      .query<AssignmentRow, [string]>(
        "SELECT * FROM pipeline_assignments WHERE idempotency_key = ?",
      )
      .get(input.idempotencyKey);
    if (existing) return assignmentFromRow(existing);

    const now = this.clock.now();
    const assignment: Assignment = {
      id: input.id,
      runId: input.runId,
      parentAssignmentId: input.parentAssignmentId,
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      status: input.status ?? "pending",
      objective: input.objective,
      contextRefs: [...input.contextRefs],
      artifactRefs: [...input.artifactRefs],
      acceptanceCriteria: [...input.acceptanceCriteria],
      mutationScope: [...input.mutationScope],
      dependsOn: [...input.dependsOn],
      attempt: input.attempt,
      attemptId: input.attemptId,
      candidateRevisionDigest: input.candidateRevisionDigest,
      deadlineAt: input.deadlineAt,
      leaseOwner: input.leaseOwner ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
    this.insertAssignment(assignment);
    return assignment;
  }

  async getAssignment(id: string): Promise<Assignment | undefined> {
    const row = this.db
      .query<AssignmentRow, [string]>(
        "SELECT * FROM pipeline_assignments WHERE id = ?",
      )
      .get(id);
    return row ? assignmentFromRow(row) : undefined;
  }

  async listAssignments(runId: string): Promise<Assignment[]> {
    return this.db
      .query<AssignmentRow, [string]>(
        `SELECT * FROM pipeline_assignments
         WHERE run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId)
      .map(assignmentFromRow);
  }

  async recordOutcomeTransaction(
    input: RecordOutcomeInput,
  ): Promise<TransitionReceipt> {
    const assignment = await this.getAssignment(input.outcome.assignmentId);
    if (!assignment) {
      return {
        status: "rejected",
        runVersion: 0,
        assignmentId: input.outcome.assignmentId,
        reason: "assignment not found",
      };
    }
    const run = await this.getRun(assignment.runId);
    if (!run) {
      return {
        status: "rejected",
        runVersion: 0,
        assignmentId: assignment.id,
        reason: "run not found",
      };
    }

    if (input.idempotencyKey) {
      const prior = this.db
        .query<EventRow, [string]>(
          "SELECT * FROM pipeline_events WHERE idempotency_key = ?",
        )
        .get(input.idempotencyKey);
      if (prior) {
        return {
          status: "duplicate",
          runVersion: run.stateVersion,
          assignmentId: assignment.id,
          reason: "duplicate idempotency key",
          eventId: prior.id,
          outcomeId: prior.outcome_id ?? undefined,
        };
      }
    }

    const recentFingerprints = this.db
      .query<{ progress_fingerprint: string }, [string]>(
        `SELECT progress_fingerprint FROM pipeline_outcomes
         WHERE assignment_id = ?
         ORDER BY created_at ASC`,
      )
      .all(assignment.id)
      .map((r) => r.progress_fingerprint);

    const maxSeq = this.db
      .query<{ max_seq: number | null }, [string]>(
        "SELECT MAX(sequence) AS max_seq FROM pipeline_events WHERE run_id = ?",
      )
      .get(run.id);
    const nextEventSequence = (maxSeq?.max_seq ?? 0) + 1;

    const decision = decideOutcomeTransaction({
      run,
      assignment,
      recentFingerprints,
      nextEventSequence,
      now: this.clock.now(),
      generateId: () => crypto.randomUUID(),
      input,
    });

    if (decision.kind === "receipt") {
      return decision.receipt;
    }

    const tx = this.db.transaction(() => {
      const cas = this.db
        .query(
          `UPDATE pipeline_runs SET
            phase = ?,
            status = ?,
            state_version = ?,
            terminal_outcome = ?,
            terminal_reason = ?,
            artifact_refs_json = ?,
            blocker_refs_json = ?,
            deadline_at = ?,
            updated_at = ?
           WHERE id = ? AND state_version = ?`,
        )
        .run(
          decision.updatedRun.phase,
          decision.updatedRun.status,
          decision.updatedRun.stateVersion,
          decision.updatedRun.terminalOutcome,
          decision.updatedRun.terminalReason,
          JSON.stringify(decision.updatedRun.artifactRefs),
          JSON.stringify(decision.updatedRun.blockerRefs),
          decision.updatedRun.deadlineAt,
          decision.updatedRun.updatedAt,
          run.id,
          run.stateVersion,
        );

      if (cas.changes !== 1) {
        throw new CasConflictError(
          this.db
            .query<{ state_version: number }, [string]>(
              "SELECT state_version FROM pipeline_runs WHERE id = ?",
            )
            .get(run.id)?.state_version ?? run.stateVersion,
        );
      }

      this.db
        .query(
          `UPDATE pipeline_assignments SET
            status = ?,
            deadline_at = ?,
            updated_at = ?
           WHERE id = ?`,
        )
        .run(
          decision.updatedAssignment.status,
          decision.updatedAssignment.deadlineAt,
          decision.updatedAssignment.updatedAt,
          decision.updatedAssignment.id,
        );

      this.db
        .query(
          `INSERT INTO pipeline_outcomes (
            id, assignment_id, action, status, reason,
            evidence_refs_json, artifact_refs_json, blockers_json,
            checks_json, confidence, progress_fingerprint, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.outcome.id,
          decision.outcome.assignmentId,
          decision.outcome.action,
          decision.outcome.status,
          decision.outcome.reason,
          JSON.stringify(decision.outcome.evidenceRefs),
          JSON.stringify(decision.outcome.artifactRefs),
          JSON.stringify(decision.outcome.blockers),
          JSON.stringify(decision.outcome.checks),
          decision.outcome.confidence,
          decision.outcome.progressFingerprint,
          decision.outcome.createdAt,
        );

      this.insertEventRow(decision.event);

      if (decision.nextAssignment) {
        this.insertAssignment(decision.nextAssignment);
      }

      if (decision.outbox) {
        this.insertOutbox(decision.outbox);
      }
    });

    try {
      tx();
      return decision.receipt;
    } catch (err) {
      if (err instanceof CasConflictError) {
        return {
          status: "rejected",
          runVersion: err.actualVersion,
          assignmentId: assignment.id,
          reason: "state version conflict",
        };
      }
      throw err;
    }
  }

  async appendEvent(
    event: Omit<PipelineEvent, "sequence"> & { sequence?: number },
  ): Promise<PipelineEvent> {
    const maxSeq = this.db
      .query<{ max_seq: number | null }, [string]>(
        "SELECT MAX(sequence) AS max_seq FROM pipeline_events WHERE run_id = ?",
      )
      .get(event.runId);
    const sequence = event.sequence ?? (maxSeq?.max_seq ?? 0) + 1;
    const full: PipelineEvent = { ...event, sequence };
    this.insertEventRow(full);
    return full;
  }

  async listEvents(runId: string): Promise<PipelineEvent[]> {
    return this.db
      .query<EventRow, [string]>(
        `SELECT * FROM pipeline_events
         WHERE run_id = ?
         ORDER BY sequence ASC`,
      )
      .all(runId)
      .map(eventFromRow);
  }

  async enqueueOutbox(record: OutboxCreate): Promise<PipelineOutboxRecord> {
    const existing = this.db
      .query<OutboxRow, [string]>(
        "SELECT * FROM pipeline_outbox WHERE idempotency_key = ?",
      )
      .get(record.idempotencyKey);
    if (existing) return outboxFromRow(existing);

    const now = this.clock.now();
    const full: PipelineOutboxRecord = {
      id: record.id,
      runId: record.runId,
      assignmentId: record.assignmentId,
      eventType: record.eventType,
      payload: { ...record.payload },
      status: record.status ?? "pending",
      attempts: record.attempts ?? 0,
      availableAt: record.availableAt ?? now,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey: record.idempotencyKey,
      createdAt: now,
      deliveredAt: null,
      lastError: null,
    };
    this.insertOutbox(full);
    return full;
  }

  async claimOutbox(
    owner: string,
    limit: number,
    leaseMs: number,
  ): Promise<PipelineOutboxRecord[]> {
    const now = this.clock.now();
    const claim = this.db.transaction(() => {
      const rows = this.db
        .query<OutboxRow, [number, number]>(
          `SELECT * FROM pipeline_outbox
           WHERE status = 'pending'
             AND available_at <= ?
             AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY created_at ASC`,
        )
        .all(now, now)
        .slice(0, Math.max(0, limit));

      const claimed: PipelineOutboxRecord[] = [];
      for (const row of rows) {
        this.db
          .query(
            `UPDATE pipeline_outbox SET
              status = 'leased',
              lease_owner = ?,
              lease_expires_at = ?,
              attempts = attempts + 1
             WHERE id = ? AND status = 'pending'`,
          )
          .run(owner, now + leaseMs, row.id);
        const updated = this.db
          .query<OutboxRow, [string]>(
            "SELECT * FROM pipeline_outbox WHERE id = ?",
          )
          .get(row.id);
        if (updated && updated.status === "leased") {
          claimed.push(outboxFromRow(updated));
        }
      }
      return claimed;
    });
    return claim();
  }

  async markOutboxDelivered(id: string): Promise<void> {
    this.db
      .query(
        `UPDATE pipeline_outbox SET
          status = 'delivered',
          lease_owner = NULL,
          lease_expires_at = NULL,
          delivered_at = ?
         WHERE id = ?`,
      )
      .run(this.clock.now(), id);
  }

  async reclaimExpiredOutboxLeases(now = this.clock.now()): Promise<number> {
    const result = this.db
      .query(
        `UPDATE pipeline_outbox SET
          status = 'pending',
          lease_owner = NULL,
          lease_expires_at = NULL
         WHERE status = 'leased'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?`,
      )
      .run(now);
    return result.changes;
  }

  async listOutbox(runId: string): Promise<PipelineOutboxRecord[]> {
    return this.db
      .query<OutboxRow, [string]>(
        "SELECT * FROM pipeline_outbox WHERE run_id = ? ORDER BY created_at ASC",
      )
      .all(runId)
      .map(outboxFromRow);
  }

  async createAttempt(attempt: PipelineAttempt): Promise<void> {
    this.db
      .query(
        `INSERT INTO pipeline_attempts (
          id, run_id, ordinal, revision_digest, status,
          invalidated_at, invalidation_reason, created_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.runId,
        attempt.ordinal,
        attempt.revisionDigest,
        attempt.status,
        attempt.invalidatedAt,
        attempt.invalidationReason,
        attempt.createdAt,
        attempt.finishedAt,
      );
  }

  async getAttempt(id: string): Promise<PipelineAttempt | undefined> {
    const row = this.db
      .query<AttemptRow, [string]>(
        "SELECT * FROM pipeline_attempts WHERE id = ?",
      )
      .get(id);
    return row ? attemptFromRow(row) : undefined;
  }

  async replaceAttemptRevision(
    attemptId: string,
    members: AttemptRevisionMember[],
  ): Promise<{ digest: string; invalidatedGateCount: number }> {
    const attempt = await this.getAttempt(attemptId);
    if (!attempt) {
      throw new Error(`attempt not found: ${attemptId}`);
    }

    const previous = await this.listRevisionMembers(attemptId);
    const canonical = canonicalizeRevisionMembers(members);
    const digest = computeRevisionDigest(canonical);
    const changed = revisionVectorChanged(previous, canonical);
    const now = this.clock.now();

    const apply = this.db.transaction(() => {
      this.db
        .query("DELETE FROM pipeline_attempt_revisions WHERE attempt_id = ?")
        .run(attemptId);

      for (const m of canonical) {
        this.db
          .query(
            `INSERT INTO pipeline_attempt_revisions (
              id, attempt_id, member_key, repo_ref, branch, head_sha,
              github_resource_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            crypto.randomUUID(),
            attemptId,
            m.memberKey,
            m.repoRef,
            m.branch,
            m.headSha,
            m.githubResourceId ?? null,
            now,
            now,
          );
      }

      let invalidatedGateCount = 0;
      if (changed && previous.length > 0) {
        const result = this.db
          .query(
            `UPDATE pipeline_gates SET status = 'invalidated', updated_at = ?
             WHERE attempt_id = ? AND status != 'invalidated'`,
          )
          .run(now, attemptId);
        invalidatedGateCount = result.changes;
        this.db
          .query(
            `UPDATE pipeline_attempts SET
              revision_digest = ?,
              status = 'invalidated',
              invalidated_at = ?,
              invalidation_reason = ?
             WHERE id = ?`,
          )
          .run(digest, now, "revision vector changed", attemptId);
      } else {
        this.db
          .query(
            "UPDATE pipeline_attempts SET revision_digest = ? WHERE id = ?",
          )
          .run(digest, attemptId);
      }
      return invalidatedGateCount;
    });

    const invalidatedGateCount = apply();
    return { digest, invalidatedGateCount };
  }

  async listRevisionMembers(
    attemptId: string,
  ): Promise<AttemptRevisionMember[]> {
    return this.db
      .query<RevisionRow, [string]>(
        `SELECT * FROM pipeline_attempt_revisions
         WHERE attempt_id = ?
         ORDER BY member_key ASC`,
      )
      .all(attemptId)
      .map((r) => ({
        memberKey: r.member_key,
        repoRef: r.repo_ref,
        branch: r.branch,
        headSha: r.head_sha,
        ...(r.github_resource_id != null
          ? { githubResourceId: r.github_resource_id }
          : {}),
      }));
  }

  async upsertGate(gate: PipelineGate): Promise<void> {
    this.db
      .query(
        `INSERT INTO pipeline_gates (
          id, run_id, attempt_id, member_key, github_resource_id,
          gate_kind, status, subject_sha, evidence_ref, provider,
          model, agent_name, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          member_key = excluded.member_key,
          github_resource_id = excluded.github_resource_id,
          gate_kind = excluded.gate_kind,
          status = excluded.status,
          subject_sha = excluded.subject_sha,
          evidence_ref = excluded.evidence_ref,
          provider = excluded.provider,
          model = excluded.model,
          agent_name = excluded.agent_name,
          updated_at = excluded.updated_at`,
      )
      .run(
        gate.id,
        gate.runId,
        gate.attemptId,
        gate.memberKey,
        gate.githubResourceId,
        gate.gateKind,
        gate.status,
        gate.subjectSha,
        gate.evidenceRef,
        gate.provider,
        gate.model,
        gate.agentName,
        gate.updatedAt,
      );
  }

  async listGates(attemptId: string): Promise<PipelineGate[]> {
    return this.db
      .query<GateRow, [string]>(
        "SELECT * FROM pipeline_gates WHERE attempt_id = ?",
      )
      .all(attemptId)
      .map(gateFromRow);
  }

  async listOutcomes(assignmentId: string): Promise<StoredOutcome[]> {
    return this.db
      .query<OutcomeRow, [string]>(
        `SELECT * FROM pipeline_outcomes
         WHERE assignment_id = ?
         ORDER BY created_at ASC`,
      )
      .all(assignmentId)
      .map(outcomeFromRow);
  }

  // -------------------------------------------------------------------------
  // GitHub resource tracking (Phase 5 shadow)
  // -------------------------------------------------------------------------

  async upsertGitHubResource(resource: GitHubResource): Promise<void> {
    this.db
      .query(
        `INSERT INTO github_resources (
          id, kind, owner, repo, number, node_id, snapshot_json,
          last_polled_at, next_poll_at, poll_class, consecutive_failures,
          last_error, lease_owner, lease_until, terminal_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner, repo, number) DO UPDATE SET
          kind = excluded.kind,
          node_id = excluded.node_id,
          snapshot_json = excluded.snapshot_json,
          last_polled_at = excluded.last_polled_at,
          next_poll_at = excluded.next_poll_at,
          poll_class = excluded.poll_class,
          consecutive_failures = excluded.consecutive_failures,
          last_error = excluded.last_error,
          lease_owner = excluded.lease_owner,
          lease_until = excluded.lease_until,
          terminal_at = excluded.terminal_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        resource.id,
        resource.kind,
        resource.owner,
        resource.repo,
        resource.number,
        resource.nodeId,
        resource.snapshot ? JSON.stringify(resource.snapshot) : null,
        resource.lastPolledAt,
        resource.nextPollAt,
        resource.pollClass,
        resource.consecutiveFailures,
        resource.lastError,
        resource.leaseOwner,
        resource.leaseUntil,
        resource.terminalAt,
        resource.createdAt,
        resource.updatedAt,
      );
  }

  async getGitHubResource(id: string): Promise<GitHubResource | undefined> {
    const row = this.db
      .query<GitHubResourceRow, [string]>(
        "SELECT * FROM github_resources WHERE id = ?",
      )
      .get(id);
    return row ? githubResourceFromRow(row) : undefined;
  }

  async getGitHubResourceByCoords(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResource | undefined> {
    const row = this.db
      .query<GitHubResourceRow, [string, string, number]>(
        `SELECT * FROM github_resources
         WHERE owner = ? AND repo = ? AND number = ?`,
      )
      .get(owner, repo, number);
    return row ? githubResourceFromRow(row) : undefined;
  }

  async listActiveTrackedResources(): Promise<GitHubResource[]> {
    return this.db
      .query<GitHubResourceRow, []>(
        `SELECT DISTINCT g.*
         FROM github_resources g
         INNER JOIN pipeline_github_resources p
           ON p.resource_id = g.id AND p.active = 1
         ORDER BY g.next_poll_at ASC`,
      )
      .all()
      .map(githubResourceFromRow);
  }

  async listDueGitHubResources(
    now: number,
    limit = 50,
  ): Promise<GitHubResource[]> {
    return this.db
      .query<GitHubResourceRow, [number, number, number]>(
        `SELECT DISTINCT g.*
         FROM github_resources g
         INNER JOIN pipeline_github_resources p
           ON p.resource_id = g.id AND p.active = 1
         WHERE g.next_poll_at <= ?
           AND (g.lease_owner IS NULL OR g.lease_until IS NULL OR g.lease_until <= ?)
         ORDER BY g.next_poll_at ASC
         LIMIT ?`,
      )
      .all(now, now, Math.max(0, limit))
      .map(githubResourceFromRow);
  }

  async claimGitHubResourceLease(
    id: string,
    owner: string,
    leaseMs: number,
    now = this.clock.now(),
  ): Promise<boolean> {
    const result = this.db
      .query(
        `UPDATE github_resources SET
          lease_owner = ?,
          lease_until = ?,
          updated_at = ?
         WHERE id = ?
           AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)`,
      )
      .run(owner, now + leaseMs, now, id, now, owner);
    return result.changes > 0;
  }

  async releaseGitHubResourceLease(id: string): Promise<void> {
    this.db
      .query(
        `UPDATE github_resources SET
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(this.clock.now(), id);
  }

  async recordGitHubPollFailure(
    resourceId: string,
    error: string,
    nextPollAt: number,
  ): Promise<void> {
    const now = this.clock.now();
    this.db
      .query(
        `UPDATE github_resources SET
          consecutive_failures = consecutive_failures + 1,
          last_error = ?,
          last_polled_at = ?,
          next_poll_at = ?,
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(error, now, nextPollAt, now, resourceId);
  }

  async registerPipelineGitHubResource(
    assoc: Omit<PipelineGitHubResource, "createdAt" | "updatedAt"> & {
      createdAt?: number;
      updatedAt?: number;
    },
  ): Promise<PipelineGitHubResource> {
    const now = this.clock.now();
    const createdAt = assoc.createdAt ?? now;
    const updatedAt = assoc.updatedAt ?? now;
    this.db
      .query(
        `INSERT INTO pipeline_github_resources (
          id, run_id, resource_id, role, workstream_key, attempt_id,
          registered_by_assignment_id, expected_head_sha, active,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, resource_id, role) DO UPDATE SET
          workstream_key = excluded.workstream_key,
          attempt_id = excluded.attempt_id,
          registered_by_assignment_id = excluded.registered_by_assignment_id,
          expected_head_sha = excluded.expected_head_sha,
          active = excluded.active,
          updated_at = excluded.updated_at`,
      )
      .run(
        assoc.id,
        assoc.runId,
        assoc.resourceId,
        assoc.role,
        assoc.workstreamKey,
        assoc.attemptId,
        assoc.registeredByAssignmentId,
        assoc.expectedHeadSha,
        assoc.active ? 1 : 0,
        createdAt,
        updatedAt,
      );
    const row = this.db
      .query<PipelineGitHubResourceRow, [string, string, string]>(
        `SELECT * FROM pipeline_github_resources
         WHERE run_id = ? AND resource_id = ? AND role = ?`,
      )
      .get(assoc.runId, assoc.resourceId, assoc.role);
    if (!row) {
      throw new Error("failed to register pipeline_github_resources row");
    }
    return pipelineGitHubResourceFromRow(row);
  }

  async listPipelineGitHubResources(
    runId: string,
    activeOnly = false,
  ): Promise<PipelineGitHubResource[]> {
    if (activeOnly) {
      return this.db
        .query<PipelineGitHubResourceRow, [string]>(
          `SELECT * FROM pipeline_github_resources
           WHERE run_id = ? AND active = 1
           ORDER BY created_at ASC`,
        )
        .all(runId)
        .map(pipelineGitHubResourceFromRow);
    }
    return this.db
      .query<PipelineGitHubResourceRow, [string]>(
        `SELECT * FROM pipeline_github_resources
         WHERE run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId)
      .map(pipelineGitHubResourceFromRow);
  }

  async listAssociationsForResource(
    resourceId: string,
    activeOnly = false,
  ): Promise<PipelineGitHubResource[]> {
    if (activeOnly) {
      return this.db
        .query<PipelineGitHubResourceRow, [string]>(
          `SELECT * FROM pipeline_github_resources
           WHERE resource_id = ? AND active = 1
           ORDER BY created_at ASC`,
        )
        .all(resourceId)
        .map(pipelineGitHubResourceFromRow);
    }
    return this.db
      .query<PipelineGitHubResourceRow, [string]>(
        `SELECT * FROM pipeline_github_resources
         WHERE resource_id = ?
         ORDER BY created_at ASC`,
      )
      .all(resourceId)
      .map(pipelineGitHubResourceFromRow);
  }

  async deactivatePipelineGitHubResource(id: string): Promise<void> {
    this.db
      .query(
        `UPDATE pipeline_github_resources SET
          active = 0,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(this.clock.now(), id);
  }

  async applyGitHubSnapshotShadow(input: {
    resourceId: string;
    snapshot: PrSnapshot;
    nodeId?: string | null;
    events: GitHubSemanticEvent[];
    proposedReductions: ProposedReduction[];
    nextPollAt: number;
    pollClass?: GitHubPollClass;
    terminalAt?: number | null;
  }): Promise<ShadowPersistResult> {
    const now = this.clock.now();
    const apply = this.db.transaction(() => {
      const resource = this.db
        .query<GitHubResourceRow, [string]>(
          "SELECT * FROM github_resources WHERE id = ?",
        )
        .get(input.resourceId);
      if (!resource) {
        throw new Error(`github resource not found: ${input.resourceId}`);
      }

      this.db
        .query(
          `UPDATE github_resources SET
            node_id = COALESCE(?, node_id),
            snapshot_json = ?,
            last_polled_at = ?,
            next_poll_at = ?,
            poll_class = COALESCE(?, poll_class),
            consecutive_failures = 0,
            last_error = NULL,
            lease_owner = NULL,
            lease_until = NULL,
            terminal_at = COALESCE(?, terminal_at),
            updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.nodeId ?? null,
          JSON.stringify(input.snapshot),
          now,
          input.nextPollAt,
          input.pollClass ?? null,
          input.terminalAt ?? null,
          now,
          input.resourceId,
        );

      // When terminalAt is explicitly null (non-terminal), clear it.
      if (input.terminalAt === null) {
        this.db
          .query(
            `UPDATE github_resources SET terminal_at = NULL WHERE id = ?`,
          )
          .run(input.resourceId);
      }

      const associations = this.db
        .query<PipelineGitHubResourceRow, [string]>(
          `SELECT * FROM pipeline_github_resources
           WHERE resource_id = ? AND active = 1
           ORDER BY created_at ASC`,
        )
        .all(input.resourceId)
        .map(pipelineGitHubResourceFromRow);

      for (const event of input.events) {
        for (const assoc of associations) {
          const idempotencyKey = `${event.fingerprint}:run:${assoc.runId}:role:${assoc.role}`;
          const existing = this.db
            .query<EventRow, [string]>(
              "SELECT * FROM pipeline_events WHERE idempotency_key = ?",
            )
            .get(idempotencyKey);
          if (existing) continue;

          const maxSeq = this.db
            .query<{ m: number | null }, [string]>(
              "SELECT MAX(sequence) as m FROM pipeline_events WHERE run_id = ?",
            )
            .get(assoc.runId);
          const sequence = (maxSeq?.m ?? 0) + 1;
          const reductions = input.proposedReductions.filter(
            (r) =>
              r.kind === "checks_apply_to_sha" ||
              (r.kind === "invalidate_aggregate_gates" &&
                r.workstreamKey === assoc.workstreamKey) ||
              (r.kind === "role_specific_merge" && r.role === assoc.role),
          );
          const full: PipelineEvent = {
            id: crypto.randomUUID(),
            runId: assoc.runId,
            sequence,
            eventType: event.type,
            actorType: "system",
            actorId: "github-reconciler",
            assignmentId: assoc.registeredByAssignmentId,
            outcomeId: null,
            fromPhase: null,
            toPhase: null,
            payloadVersion: 1,
            payload: {
              resourceId: event.resourceId,
              owner: event.owner,
              repo: event.repo,
              number: event.number,
              role: assoc.role,
              workstreamKey: assoc.workstreamKey,
              attemptId: assoc.attemptId,
              previous: event.previous,
              next: event.next,
              fingerprint: event.fingerprint,
              proposedReductions: reductions,
              shadow: true,
              wakesDelivered: false,
            },
            idempotencyKey,
            occurredAt: event.observedAt,
            observedAt: now,
          };
          this.insertEventRow(full);
        }
      }

      return {
        resourceId: input.resourceId,
        events: input.events.map((e) => ({ ...e })),
        proposedReductions: input.proposedReductions.map((r) => ({ ...r })),
        wakesDelivered: false,
        associationsTouched: associations.length,
      } satisfies ShadowPersistResult;
    });

    return apply();
  }

  // -------------------------------------------------------------------------
  // Dev-server jobs (Phase 6)
  // -------------------------------------------------------------------------

  async createDevServerJob(job: DevServerJobCreate): Promise<DevServerJob> {
    const existing = this.db
      .query<DevServerJobRow, [string]>(
        "SELECT * FROM dev_server_jobs WHERE assignment_id = ?",
      )
      .get(job.assignmentId);
    if (existing) return devServerJobFromRow(existing);

    const now = this.clock.now();
    const full: DevServerJob = {
      id: job.id,
      runId: job.runId,
      assignmentId: job.assignmentId,
      channelId: job.channelId,
      threadId: job.threadId,
      repo: job.repo,
      branch: job.branch,
      status: job.status ?? "requested",
      readyUrl: job.readyUrl ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      deadlineAt: job.deadlineAt,
      pid: null,
      error: null,
      releasedAt: null,
      releaseReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO dev_server_jobs (
          id, run_id, assignment_id, channel_id, thread_id,
          repo, branch, status, ready_url, lease_owner, lease_expires_at,
          deadline_at, pid, error, released_at, release_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.runId,
        full.assignmentId,
        full.channelId,
        full.threadId,
        full.repo,
        full.branch,
        full.status,
        full.readyUrl,
        full.leaseOwner,
        full.leaseExpiresAt,
        full.deadlineAt,
        full.pid,
        full.error,
        full.releasedAt,
        full.releaseReason,
        full.createdAt,
        full.updatedAt,
      );
    return full;
  }

  async getDevServerJob(id: string): Promise<DevServerJob | undefined> {
    const row = this.db
      .query<DevServerJobRow, [string]>(
        "SELECT * FROM dev_server_jobs WHERE id = ?",
      )
      .get(id);
    return row ? devServerJobFromRow(row) : undefined;
  }

  async getDevServerJobByAssignment(
    assignmentId: string,
  ): Promise<DevServerJob | undefined> {
    const row = this.db
      .query<DevServerJobRow, [string]>(
        "SELECT * FROM dev_server_jobs WHERE assignment_id = ?",
      )
      .get(assignmentId);
    return row ? devServerJobFromRow(row) : undefined;
  }

  async listDevServerJobs(filter?: {
    runId?: string;
    status?: DevServerJobStatus | DevServerJobStatus[];
  }): Promise<DevServerJob[]> {
    let rows: DevServerJobRow[];
    if (filter?.runId && filter.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      const placeholders = statuses.map(() => "?").join(",");
      rows = this.db
        .query<DevServerJobRow, (string | number)[]>(
          `SELECT * FROM dev_server_jobs
           WHERE run_id = ? AND status IN (${placeholders})
           ORDER BY created_at ASC`,
        )
        .all(filter.runId, ...statuses);
    } else if (filter?.runId) {
      rows = this.db
        .query<DevServerJobRow, [string]>(
          `SELECT * FROM dev_server_jobs WHERE run_id = ? ORDER BY created_at ASC`,
        )
        .all(filter.runId);
    } else if (filter?.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      const placeholders = statuses.map(() => "?").join(",");
      rows = this.db
        .query<DevServerJobRow, string[]>(
          `SELECT * FROM dev_server_jobs
           WHERE status IN (${placeholders})
           ORDER BY created_at ASC`,
        )
        .all(...statuses);
    } else {
      rows = this.db
        .query<DevServerJobRow, []>(
          "SELECT * FROM dev_server_jobs ORDER BY created_at ASC",
        )
        .all();
    }
    return rows.map(devServerJobFromRow);
  }

  async updateDevServerJob(
    id: string,
    patch: Partial<
      Pick<
        DevServerJob,
        | "status"
        | "readyUrl"
        | "leaseOwner"
        | "leaseExpiresAt"
        | "pid"
        | "error"
        | "releasedAt"
        | "releaseReason"
        | "deadlineAt"
      >
    >,
  ): Promise<DevServerJob | undefined> {
    const existing = await this.getDevServerJob(id);
    if (!existing) return undefined;
    if (isTerminalDevServerStatus(existing.status)) return existing;
    const updated: DevServerJob = {
      ...existing,
      ...patch,
      updatedAt: this.clock.now(),
    };
    this.db
      .query(
        `UPDATE dev_server_jobs SET
          status = ?,
          ready_url = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          deadline_at = ?,
          pid = ?,
          error = ?,
          released_at = ?,
          release_reason = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.status,
        updated.readyUrl,
        updated.leaseOwner,
        updated.leaseExpiresAt,
        updated.deadlineAt,
        updated.pid,
        updated.error,
        updated.releasedAt,
        updated.releaseReason,
        updated.updatedAt,
        id,
      );
    return updated;
  }

  async releaseDevServerJob(
    id: string,
    reason: string,
    error?: string | null,
  ): Promise<boolean> {
    const existing = await this.getDevServerJob(id);
    if (!existing) return false;
    if (isTerminalDevServerStatus(existing.status)) return false;
    const status = releaseStatusForReason(reason);
    const now = this.clock.now();
    const result = this.db
      .query(
        `UPDATE dev_server_jobs SET
          status = ?,
          error = COALESCE(?, error),
          released_at = ?,
          release_reason = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
         WHERE id = ? AND status NOT IN ('released', 'failed', 'cancelled', 'deadline')`,
      )
      .run(status, error ?? null, now, reason, now, id);
    return result.changes > 0;
  }

  async reclaimExpiredDevServerJobs(now = this.clock.now()): Promise<number> {
    const result = this.db
      .query(
        `UPDATE dev_server_jobs SET
          status = 'queued',
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
         WHERE status = 'acquiring'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?`,
      )
      .run(now, now);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Thread catch-up cursors
  // -------------------------------------------------------------------------

  async getThreadCursor(
    runId: string,
  ): Promise<PipelineThreadCursor | undefined> {
    const row = this.db
      .query<ThreadCursorRow, [string]>(
        "SELECT * FROM pipeline_thread_cursors WHERE run_id = ?",
      )
      .get(runId);
    return row ? threadCursorFromRow(row) : undefined;
  }

  async upsertThreadCursor(cursor: PipelineThreadCursor): Promise<void> {
    this.db
      .query(
        `INSERT INTO pipeline_thread_cursors (
          run_id, channel_id, thread_id, last_observed_ts, last_catchup_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          thread_id = excluded.thread_id,
          last_observed_ts = excluded.last_observed_ts,
          last_catchup_at = excluded.last_catchup_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        cursor.runId,
        cursor.channelId,
        cursor.threadId,
        cursor.lastObservedTs,
        cursor.lastCatchupAt,
        cursor.updatedAt,
      );
  }

  async listThreadCursors(filter?: {
    waitingRunsOnly?: boolean;
  }): Promise<PipelineThreadCursor[]> {
    if (filter?.waitingRunsOnly) {
      const rows = this.db
        .query<ThreadCursorRow, []>(
          `SELECT c.* FROM pipeline_thread_cursors c
           INNER JOIN pipeline_runs r ON r.id = c.run_id
           WHERE r.status = 'waiting'
           ORDER BY c.updated_at ASC`,
        )
        .all();
      return rows.map(threadCursorFromRow);
    }
    const rows = this.db
      .query<ThreadCursorRow, []>(
        "SELECT * FROM pipeline_thread_cursors ORDER BY updated_at ASC",
      )
      .all();
    return rows.map(threadCursorFromRow);
  }

  private insertAssignment(assignment: Assignment): void {
    this.db
      .query(
        `INSERT INTO pipeline_assignments (
          id, run_id, parent_assignment_id, source_agent, target_agent,
          status, objective, context_refs_json, artifact_refs_json,
          acceptance_json, mutation_scope_json, dependencies_json,
          attempt_number, attempt_id, candidate_revision_digest, deadline_at,
          lease_owner, lease_expires_at, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assignment.id,
        assignment.runId,
        assignment.parentAssignmentId,
        assignment.sourceAgent,
        assignment.targetAgent,
        assignment.status,
        assignment.objective,
        JSON.stringify(assignment.contextRefs),
        JSON.stringify(assignment.artifactRefs),
        JSON.stringify(assignment.acceptanceCriteria),
        JSON.stringify(assignment.mutationScope),
        JSON.stringify(assignment.dependsOn),
        assignment.attempt,
        assignment.attemptId,
        assignment.candidateRevisionDigest,
        assignment.deadlineAt,
        assignment.leaseOwner,
        assignment.leaseExpiresAt,
        assignment.idempotencyKey,
        assignment.createdAt,
        assignment.updatedAt,
      );
  }

  private insertEventRow(event: PipelineEvent): void {
    this.db
      .query(
        `INSERT INTO pipeline_events (
          id, run_id, sequence, event_type, actor_type, actor_id,
          assignment_id, outcome_id, from_phase, to_phase,
          payload_version, payload_json, idempotency_key,
          occurred_at, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.runId,
        event.sequence,
        event.eventType,
        event.actorType,
        event.actorId,
        event.assignmentId,
        event.outcomeId,
        event.fromPhase,
        event.toPhase,
        event.payloadVersion,
        JSON.stringify(event.payload),
        event.idempotencyKey,
        event.occurredAt,
        event.observedAt,
      );
  }

  private insertOutbox(record: PipelineOutboxRecord): void {
    this.db
      .query(
        `INSERT INTO pipeline_outbox (
          id, run_id, assignment_id, event_type, payload_json, status,
          attempts, available_at, lease_owner, lease_expires_at,
          idempotency_key, created_at, delivered_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        record.id,
        record.runId,
        record.assignmentId,
        record.eventType,
        JSON.stringify(record.payload),
        record.status,
        record.attempts,
        record.availableAt,
        record.leaseOwner,
        record.leaseExpiresAt,
        record.idempotencyKey,
        record.createdAt,
        record.deliveredAt,
        record.lastError,
      );
  }
}

class CasConflictError extends Error {
  constructor(readonly actualVersion: number) {
    super(`pipeline run CAS conflict; actual version ${actualVersion}`);
    this.name = "CasConflictError";
  }
}

function runFromRow(row: RunRow): PipelineRun {
  const base = {
    id: row.id,
    definitionVersion: row.definition_version,
    channelId: row.channel_id,
    threadId: row.thread_id,
    status: row.status as PipelineRunStatus,
    ownerAgent: row.owner_agent,
    repoRefs: parseJsonArray(row.repo_refs_json),
    acceptanceCriteria: parseJsonArray(row.acceptance_json),
    artifactRefs: parseJsonArray(row.artifact_refs_json),
    blockerRefs: parseJsonArray(row.blocker_refs_json),
    activeAttemptId: row.active_attempt_id,
    stateVersion: row.state_version,
    deadlineAt: row.deadline_at,
    terminalOutcome: row.terminal_outcome as TerminalOutcome,
    terminalReason: row.terminal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === "product") {
    const run: ProductRun = {
      ...base,
      kind: "product",
      phase: row.phase as ProductPhase,
    };
    return run;
  }
  const run: BugRun = {
    ...base,
    kind: "bug",
    phase: row.phase as BugPhase,
  };
  return run;
}

function assignmentFromRow(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    runId: row.run_id,
    parentAssignmentId: row.parent_assignment_id,
    sourceAgent: row.source_agent,
    targetAgent: row.target_agent,
    status: row.status as Assignment["status"],
    objective: row.objective,
    contextRefs: parseJsonArray(row.context_refs_json),
    artifactRefs: parseJsonArray(row.artifact_refs_json),
    acceptanceCriteria: parseJsonArray(row.acceptance_json),
    mutationScope: parseJsonArray(row.mutation_scope_json),
    dependsOn: parseJsonArray(row.dependencies_json),
    attempt: row.attempt_number,
    attemptId: row.attempt_id,
    candidateRevisionDigest: row.candidate_revision_digest,
    deadlineAt: row.deadline_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function outcomeFromRow(row: OutcomeRow): StoredOutcome {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    action: row.action as StoredOutcome["action"],
    status: row.status as StoredOutcome["status"],
    reason: row.reason,
    evidenceRefs: parseJsonArray(row.evidence_refs_json),
    artifactRefs: parseJsonArray(row.artifact_refs_json),
    blockers: JSON.parse(row.blockers_json) as StoredOutcome["blockers"],
    checks: JSON.parse(row.checks_json) as StoredOutcome["checks"],
    confidence: row.confidence,
    progressFingerprint: row.progress_fingerprint,
    createdAt: row.created_at,
  };
}

function eventFromRow(row: EventRow): PipelineEvent {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    eventType: row.event_type,
    actorType: row.actor_type as PipelineEvent["actorType"],
    actorId: row.actor_id,
    assignmentId: row.assignment_id,
    outcomeId: row.outcome_id,
    fromPhase: row.from_phase,
    toPhase: row.to_phase,
    payloadVersion: row.payload_version,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
  };
}

function outboxFromRow(row: OutboxRow): PipelineOutboxRecord {
  return {
    id: row.id,
    runId: row.run_id,
    assignmentId: row.assignment_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status as PipelineOutboxRecord["status"],
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
  };
}

function attemptFromRow(row: AttemptRow): PipelineAttempt {
  return {
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    revisionDigest: row.revision_digest,
    status: row.status as PipelineAttempt["status"],
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function gateFromRow(row: GateRow): PipelineGate {
  return {
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    memberKey: row.member_key,
    githubResourceId: row.github_resource_id,
    gateKind: row.gate_kind as PipelineGate["gateKind"],
    status: row.status as PipelineGate["status"],
    subjectSha: row.subject_sha,
    evidenceRef: row.evidence_ref,
    provider: row.provider,
    model: row.model,
    agentName: row.agent_name,
    updatedAt: row.updated_at,
  };
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function githubResourceFromRow(row: GitHubResourceRow): GitHubResource {
  let snapshot: PrSnapshot | null = null;
  if (row.snapshot_json) {
    try {
      snapshot = JSON.parse(row.snapshot_json) as PrSnapshot;
    } catch {
      snapshot = null;
    }
  }
  return {
    id: row.id,
    kind: "pull_request",
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    nodeId: row.node_id,
    snapshot,
    lastPolledAt: row.last_polled_at,
    nextPollAt: row.next_poll_at,
    pollClass: row.poll_class as GitHubPollClass,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    terminalAt: row.terminal_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pipelineGitHubResourceFromRow(
  row: PipelineGitHubResourceRow,
): PipelineGitHubResource {
  return {
    id: row.id,
    runId: row.run_id,
    resourceId: row.resource_id,
    role: row.role as PipelineGitHubResourceRole,
    workstreamKey: row.workstream_key,
    attemptId: row.attempt_id,
    registeredByAssignmentId: row.registered_by_assignment_id,
    expectedHeadSha: row.expected_head_sha,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function devServerJobFromRow(row: DevServerJobRow): DevServerJob {
  return {
    id: row.id,
    runId: row.run_id,
    assignmentId: row.assignment_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    repo: row.repo,
    branch: row.branch,
    status: row.status as DevServerJobStatus,
    readyUrl: row.ready_url,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    deadlineAt: row.deadline_at,
    pid: row.pid,
    error: row.error,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function threadCursorFromRow(row: ThreadCursorRow): PipelineThreadCursor {
  return {
    runId: row.run_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    lastObservedTs: row.last_observed_ts,
    lastCatchupAt: row.last_catchup_at,
    updatedAt: row.updated_at,
  };
}

