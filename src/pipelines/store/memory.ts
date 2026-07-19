import type { Clock } from "../../time/clock.ts";
import { systemClock } from "../../time/clock.ts";
import {
  computeRevisionDigest,
  canonicalizeRevisionMembers,
  revisionVectorChanged,
} from "../revision.ts";
import type {
  Assignment,
  AssignmentCreate,
  AttemptRevisionMember,
  OutboxCreate,
  PipelineAttempt,
  PipelineEvent,
  PipelineGate,
  PipelineOutboxRecord,
  PipelineRun,
  RecordOutcomeInput,
  StoredOutcome,
  TransitionReceipt,
} from "../types.ts";
import type { PipelineStore } from "./interface.ts";
import { decideOutcomeTransaction } from "./outcome-tx.ts";

export class InMemoryPipelineStore implements PipelineStore {
  private runs = new Map<string, PipelineRun>();
  private runsByThread = new Map<string, string>();
  private assignments = new Map<string, Assignment>();
  private assignmentByIdempotency = new Map<string, string>();
  private outcomes = new Map<string, StoredOutcome[]>();
  private events = new Map<string, PipelineEvent[]>();
  private eventByIdempotency = new Map<string, string>();
  private outbox = new Map<string, PipelineOutboxRecord>();
  private outboxByIdempotency = new Map<string, string>();
  private attempts = new Map<string, PipelineAttempt>();
  private revisions = new Map<string, AttemptRevisionMember[]>();
  private gates = new Map<string, PipelineGate[]>();
  private clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async createRun(run: PipelineRun): Promise<void> {
    if (this.runs.has(run.id)) {
      throw new Error(`pipeline run already exists: ${run.id}`);
    }
    const existingThread = this.runsByThread.get(run.threadId);
    if (existingThread) {
      const existing = this.runs.get(existingThread);
      if (existing && existing.status !== "terminal") {
        throw new Error(
          `active pipeline run already exists for thread ${run.threadId}`,
        );
      }
    }
    this.runs.set(run.id, cloneRun(run));
    this.runsByThread.set(run.threadId, run.id);
  }

  async getRun(id: string): Promise<PipelineRun | undefined> {
    const run = this.runs.get(id);
    return run ? cloneRun(run) : undefined;
  }

  async getRunByThread(threadId: string): Promise<PipelineRun | undefined> {
    const id = this.runsByThread.get(threadId);
    if (!id) return undefined;
    return this.getRun(id);
  }

  async createAssignment(input: AssignmentCreate): Promise<Assignment> {
    const existingId = this.assignmentByIdempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.assignments.get(existingId);
      if (existing) return cloneAssignment(existing);
    }
    if (this.assignments.has(input.id)) {
      throw new Error(`assignment already exists: ${input.id}`);
    }
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
    this.assignments.set(assignment.id, assignment);
    this.assignmentByIdempotency.set(assignment.idempotencyKey, assignment.id);
    return cloneAssignment(assignment);
  }

  async getAssignment(id: string): Promise<Assignment | undefined> {
    const a = this.assignments.get(id);
    return a ? cloneAssignment(a) : undefined;
  }

  async listAssignments(runId: string): Promise<Assignment[]> {
    return [...this.assignments.values()]
      .filter((a) => a.runId === runId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneAssignment);
  }

  async recordOutcomeTransaction(
    input: RecordOutcomeInput,
  ): Promise<TransitionReceipt> {
    const assignment = this.assignments.get(input.outcome.assignmentId);
    if (!assignment) {
      return {
        status: "rejected",
        runVersion: 0,
        assignmentId: input.outcome.assignmentId,
        reason: "assignment not found",
      };
    }
    const run = this.runs.get(assignment.runId);
    if (!run) {
      return {
        status: "rejected",
        runVersion: 0,
        assignmentId: assignment.id,
        reason: "run not found",
      };
    }

    // Event idempotency: return prior receipt as duplicate.
    if (input.idempotencyKey) {
      const priorEventId = this.eventByIdempotency.get(input.idempotencyKey);
      if (priorEventId) {
        const events = this.events.get(run.id) ?? [];
        const prior = events.find((e) => e.id === priorEventId);
        return {
          status: "duplicate",
          runVersion: run.stateVersion,
          assignmentId: assignment.id,
          reason: "duplicate idempotency key",
          eventId: prior?.id,
          outcomeId: prior?.outcomeId ?? undefined,
        };
      }
    }

    const recentFingerprints = (this.outcomes.get(assignment.id) ?? []).map(
      (o) => o.progressFingerprint,
    );
    const nextEventSequence = (this.events.get(run.id)?.length ?? 0) + 1;

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

    // CAS on state_version
    if (this.runs.get(run.id)?.stateVersion !== run.stateVersion) {
      return {
        status: "rejected",
        runVersion: this.runs.get(run.id)?.stateVersion ?? run.stateVersion,
        assignmentId: assignment.id,
        reason: "state version conflict",
      };
    }

    this.runs.set(decision.updatedRun.id, cloneRun(decision.updatedRun));
    this.assignments.set(
      decision.updatedAssignment.id,
      cloneAssignment(decision.updatedAssignment),
    );

    const list = this.outcomes.get(assignment.id) ?? [];
    list.push({ ...decision.outcome });
    this.outcomes.set(assignment.id, list);

    const events = this.events.get(run.id) ?? [];
    events.push({ ...decision.event, payload: { ...decision.event.payload } });
    this.events.set(run.id, events);
    if (decision.event.idempotencyKey) {
      this.eventByIdempotency.set(
        decision.event.idempotencyKey,
        decision.event.id,
      );
    }

    if (decision.nextAssignment) {
      this.assignments.set(
        decision.nextAssignment.id,
        cloneAssignment(decision.nextAssignment),
      );
      this.assignmentByIdempotency.set(
        decision.nextAssignment.idempotencyKey,
        decision.nextAssignment.id,
      );
    }

    if (decision.outbox) {
      if (!this.outboxByIdempotency.has(decision.outbox.idempotencyKey)) {
        this.outbox.set(decision.outbox.id, { ...decision.outbox });
        this.outboxByIdempotency.set(
          decision.outbox.idempotencyKey,
          decision.outbox.id,
        );
      }
    }

    return decision.receipt;
  }

  async appendEvent(
    event: Omit<PipelineEvent, "sequence"> & { sequence?: number },
  ): Promise<PipelineEvent> {
    const events = this.events.get(event.runId) ?? [];
    const sequence = event.sequence ?? events.length + 1;
    const full: PipelineEvent = {
      ...event,
      sequence,
      payload: { ...event.payload },
    };
    events.push(full);
    this.events.set(event.runId, events);
    if (full.idempotencyKey) {
      this.eventByIdempotency.set(full.idempotencyKey, full.id);
    }
    return { ...full, payload: { ...full.payload } };
  }

  async listEvents(runId: string): Promise<PipelineEvent[]> {
    return (this.events.get(runId) ?? []).map((e) => ({
      ...e,
      payload: { ...e.payload },
    }));
  }

  async enqueueOutbox(record: OutboxCreate): Promise<PipelineOutboxRecord> {
    const existingId = this.outboxByIdempotency.get(record.idempotencyKey);
    if (existingId) {
      const existing = this.outbox.get(existingId);
      if (existing) return { ...existing };
    }
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
    this.outbox.set(full.id, full);
    this.outboxByIdempotency.set(full.idempotencyKey, full.id);
    return { ...full };
  }

  async claimOutbox(
    owner: string,
    limit: number,
    leaseMs: number,
  ): Promise<PipelineOutboxRecord[]> {
    const now = this.clock.now();
    const ready = [...this.outbox.values()]
      .filter(
        (r) =>
          r.status === "pending" &&
          r.availableAt <= now &&
          (r.leaseOwner == null ||
            (r.leaseExpiresAt != null && r.leaseExpiresAt <= now)),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);

    const claimed: PipelineOutboxRecord[] = [];
    for (const r of ready) {
      const updated: PipelineOutboxRecord = {
        ...r,
        status: "leased",
        leaseOwner: owner,
        leaseExpiresAt: now + leaseMs,
        attempts: r.attempts + 1,
      };
      this.outbox.set(r.id, updated);
      claimed.push({ ...updated });
    }
    return claimed;
  }

  async markOutboxDelivered(id: string): Promise<void> {
    const r = this.outbox.get(id);
    if (!r) return;
    this.outbox.set(id, {
      ...r,
      status: "delivered",
      leaseOwner: null,
      leaseExpiresAt: null,
      deliveredAt: this.clock.now(),
    });
  }

  async reclaimExpiredOutboxLeases(now = this.clock.now()): Promise<number> {
    let count = 0;
    for (const [id, r] of this.outbox) {
      if (
        r.status === "leased" &&
        r.leaseExpiresAt != null &&
        r.leaseExpiresAt <= now
      ) {
        this.outbox.set(id, {
          ...r,
          status: "pending",
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        count += 1;
      }
    }
    return count;
  }

  async listOutbox(runId: string): Promise<PipelineOutboxRecord[]> {
    return [...this.outbox.values()]
      .filter((r) => r.runId === runId)
      .map((r) => ({ ...r }));
  }

  async createAttempt(attempt: PipelineAttempt): Promise<void> {
    if (this.attempts.has(attempt.id)) {
      throw new Error(`attempt already exists: ${attempt.id}`);
    }
    this.attempts.set(attempt.id, { ...attempt });
  }

  async getAttempt(id: string): Promise<PipelineAttempt | undefined> {
    const a = this.attempts.get(id);
    return a ? { ...a } : undefined;
  }

  async replaceAttemptRevision(
    attemptId: string,
    members: AttemptRevisionMember[],
  ): Promise<{ digest: string; invalidatedGateCount: number }> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new Error(`attempt not found: ${attemptId}`);
    }
    const previous = this.revisions.get(attemptId) ?? [];
    const canonical = canonicalizeRevisionMembers(members);
    const digest = computeRevisionDigest(canonical);
    const changed = revisionVectorChanged(previous, canonical);
    this.revisions.set(attemptId, canonical);

    let invalidatedGateCount = 0;
    if (changed && previous.length > 0) {
      const gates = this.gates.get(attemptId) ?? [];
      const updated = gates.map((g) => {
        if (g.status === "invalidated") return g;
        invalidatedGateCount += 1;
        return { ...g, status: "invalidated" as const, updatedAt: this.clock.now() };
      });
      this.gates.set(attemptId, updated);
      this.attempts.set(attemptId, {
        ...attempt,
        revisionDigest: digest,
        status: "invalidated",
        invalidatedAt: this.clock.now(),
        invalidationReason: "revision vector changed",
      });
    } else {
      this.attempts.set(attemptId, {
        ...attempt,
        revisionDigest: digest,
      });
    }
    return { digest, invalidatedGateCount };
  }

  async listRevisionMembers(
    attemptId: string,
  ): Promise<AttemptRevisionMember[]> {
    return [...(this.revisions.get(attemptId) ?? [])];
  }

  async upsertGate(gate: PipelineGate): Promise<void> {
    const gates = this.gates.get(gate.attemptId) ?? [];
    const idx = gates.findIndex((g) => g.id === gate.id);
    if (idx >= 0) {
      gates[idx] = { ...gate };
    } else {
      gates.push({ ...gate });
    }
    this.gates.set(gate.attemptId, gates);
  }

  async listGates(attemptId: string): Promise<PipelineGate[]> {
    return (this.gates.get(attemptId) ?? []).map((g) => ({ ...g }));
  }

  async listOutcomes(assignmentId: string): Promise<StoredOutcome[]> {
    return (this.outcomes.get(assignmentId) ?? []).map((o) => ({ ...o }));
  }
}

function cloneRun(run: PipelineRun): PipelineRun {
  return {
    ...run,
    repoRefs: [...run.repoRefs],
    acceptanceCriteria: [...run.acceptanceCriteria],
    artifactRefs: [...run.artifactRefs],
    blockerRefs: [...run.blockerRefs],
  } as PipelineRun;
}

function cloneAssignment(a: Assignment): Assignment {
  return {
    ...a,
    contextRefs: [...a.contextRefs],
    artifactRefs: [...a.artifactRefs],
    acceptanceCriteria: [...a.acceptanceCriteria],
    mutationScope: [...a.mutationScope],
    dependsOn: [...a.dependsOn],
  };
}
