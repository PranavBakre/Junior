import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  OutboxCreate,
  PipelineAttempt,
  PipelineEvent,
  PipelineGate,
  PipelineOutboxRecord,
  PipelineRun,
  PipelineRunStatus,
  ProductPhase,
  ProductRun,
  RecordOutcomeInput,
  StoredOutcome,
  TerminalOutcome,
  TransitionReceipt,
} from "../types.ts";
import type { PipelineStore } from "./interface.ts";
import { decideOutcomeTransaction } from "./outcome-tx.ts";

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

