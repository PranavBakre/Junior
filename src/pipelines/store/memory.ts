import type { Clock } from "../../time/clock.ts";
import { systemClock } from "../../time/clock.ts";
import type {
  GitHubPollClass,
  GitHubResource,
  GitHubSemanticEvent,
  PipelineGitHubResource,
  PrSnapshot,
  ProposedReduction,
  ShadowPersistResult,
} from "../../github/types.ts";
import {
  computeRevisionDigest,
  canonicalizeRevisionMembers,
  revisionVectorChanged,
} from "../revision.ts";
import type {
  Assignment,
  AssignmentCreate,
  AttemptRevisionMember,
  DevServerJob,
  DevServerJobCreate,
  DevServerJobStatus,
  GitHubResourceRegistration,
  OutboxCreate,
  PipelineAttempt,
  PipelineEvent,
  PipelineGate,
  PipelineOutboxRecord,
  PipelineRun,
  PipelineThreadCursor,
  RecordOutcomeInput,
  StoredOutcome,
  TransitionReceipt,
} from "../types.ts";
import type { PipelineStore } from "./interface.ts";
import { decideOutcomeTransaction } from "./outcome-tx.ts";
import {
  isTerminalDevServerStatus,
  releaseStatusForReason,
} from "../dev-server-jobs.ts";

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
  private githubResources = new Map<string, GitHubResource>();
  private githubByCoords = new Map<string, string>();
  private pipelineGithub = new Map<string, PipelineGitHubResource>();
  private devServerJobs = new Map<string, DevServerJob>();
  private devServerJobsByAssignment = new Map<string, string>();
  private threadCursors = new Map<string, PipelineThreadCursor>();
  private clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async createRun(run: PipelineRun): Promise<void> {
    if (this.runs.has(run.id)) {
      throw new Error(`pipeline run already exists: ${run.id}`);
    }
    if (run.status !== "terminal") {
      for (const existing of this.runs.values()) {
        if (
          existing.threadId === run.threadId &&
          existing.status !== "terminal"
        ) {
          throw new Error(
            `active pipeline run already exists for thread ${run.threadId}`,
          );
        }
      }
    }
    this.runs.set(run.id, cloneRun(run));
    this.runsByThread.set(run.threadId, run.id);
  }

  async createRunWithAssignment(input: {
    run: PipelineRun;
    assignment: AssignmentCreate;
    events?: Array<Omit<PipelineEvent, "sequence"> & { sequence?: number }>;
  }): Promise<Assignment> {
    // Memory store is single-threaded; still apply all-or-nothing semantics.
    await this.createRun(input.run);
    try {
      const assignment = await this.createAssignment(input.assignment);
      for (const event of input.events ?? []) {
        await this.appendEvent(event);
      }
      return assignment;
    } catch (err) {
      // Roll back run + any partial state.
      this.runs.delete(input.run.id);
      if (this.runsByThread.get(input.run.threadId) === input.run.id) {
        this.runsByThread.delete(input.run.threadId);
      }
      this.assignments.delete(input.assignment.id);
      this.assignmentByIdempotency.delete(input.assignment.idempotencyKey);
      this.events.delete(input.run.id);
      throw err;
    }
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

    if (decision.outbox && !input.suppressDispatch) {
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
    const maxAttempts = 8;
    // Dead-letter exhausted rows.
    for (const [id, r] of this.outbox) {
      if (
        (r.status === "pending" || r.status === "leased") &&
        r.attempts >= maxAttempts
      ) {
        this.outbox.set(id, {
          ...r,
          status: "dead",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: r.lastError ?? "max attempts exceeded",
        });
      }
    }
    const ready = [...this.outbox.values()]
      .filter(
        (r) =>
          r.status === "pending" &&
          r.attempts < maxAttempts &&
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

  async listTerminalRuns(filter?: {
    updatedBefore?: number;
  }): Promise<PipelineRun[]> {
    return [...this.runs.values()]
      .filter((r) => {
        if (r.status !== "terminal") return false;
        if (
          filter?.updatedBefore != null &&
          r.updatedAt > filter.updatedBefore
        ) {
          return false;
        }
        return true;
      })
      .map(cloneRun);
  }

  async compactTerminalRunHistory(runId: string): Promise<{
    outboxCompacted: number;
    eventsCompacted: number;
  }> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "terminal") {
      return { outboxCompacted: 0, eventsCompacted: 0 };
    }
    let outboxCompacted = 0;
    for (const [id, r] of this.outbox) {
      if (r.runId !== runId) continue;
      if (r.status !== "delivered" && r.status !== "dead") continue;
      if (r.payload && Object.keys(r.payload).length === 0) continue;
      if (r.payload?.compacted === true) continue;
      this.outbox.set(id, {
        ...r,
        payload: { compacted: true },
      });
      outboxCompacted += 1;
    }
    let eventsCompacted = 0;
    const events = this.events.get(runId) ?? [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.payload?.compacted === true) continue;
      if (!e.payload || Object.keys(e.payload).length === 0) continue;
      events[i] = {
        ...e,
        payload: {
          compacted: true,
          eventType: e.eventType,
          fromPhase: e.fromPhase,
          toPhase: e.toPhase,
        },
      };
      eventsCompacted += 1;
    }
    this.events.set(runId, events);
    return { outboxCompacted, eventsCompacted };
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
      // Bump run CAS version so stale outcomes cannot land on invalidated gates.
      const run = this.runs.get(attempt.runId);
      if (run && run.status !== "terminal") {
        this.runs.set(run.id, {
          ...run,
          stateVersion: run.stateVersion + 1,
          updatedAt: this.clock.now(),
        });
      }
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

  // -------------------------------------------------------------------------
  // GitHub resource tracking (Phase 5 shadow)
  // -------------------------------------------------------------------------

  async upsertGitHubResource(resource: GitHubResource): Promise<void> {
    const coords = coordsKey(resource.owner, resource.repo, resource.number);
    const existingId = this.githubByCoords.get(coords);
    if (existingId && existingId !== resource.id) {
      throw new Error(
        `github resource already exists for ${coords}: ${existingId}`,
      );
    }
    this.githubResources.set(resource.id, cloneGitHubResource(resource));
    this.githubByCoords.set(coords, resource.id);
  }

  async getGitHubResource(id: string): Promise<GitHubResource | undefined> {
    const r = this.githubResources.get(id);
    return r ? cloneGitHubResource(r) : undefined;
  }

  async getGitHubResourceByCoords(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResource | undefined> {
    const id = this.githubByCoords.get(coordsKey(owner, repo, number));
    if (!id) return undefined;
    return this.getGitHubResource(id);
  }

  async listActiveTrackedResources(): Promise<GitHubResource[]> {
    const activeResourceIds = new Set(
      [...this.pipelineGithub.values()]
        .filter((a) => a.active)
        .map((a) => a.resourceId),
    );
    return [...this.githubResources.values()]
      .filter((r) => activeResourceIds.has(r.id))
      .map(cloneGitHubResource);
  }

  async listDueGitHubResources(
    now: number,
    limit = 50,
  ): Promise<GitHubResource[]> {
    const active = await this.listActiveTrackedResources();
    return active
      .filter(
        (r) =>
          r.nextPollAt <= now &&
          (r.leaseOwner == null ||
            r.leaseUntil == null ||
            r.leaseUntil <= now),
      )
      .sort((a, b) => a.nextPollAt - b.nextPollAt)
      .slice(0, Math.max(0, limit))
      .map(cloneGitHubResource);
  }

  async claimGitHubResourceLease(
    id: string,
    owner: string,
    leaseMs: number,
    now = this.clock.now(),
  ): Promise<boolean> {
    const r = this.githubResources.get(id);
    if (!r) return false;
    if (
      r.leaseOwner != null &&
      r.leaseUntil != null &&
      r.leaseUntil > now &&
      r.leaseOwner !== owner
    ) {
      return false;
    }
    this.githubResources.set(id, {
      ...r,
      leaseOwner: owner,
      leaseUntil: now + leaseMs,
      updatedAt: now,
    });
    return true;
  }

  async releaseGitHubResourceLease(id: string): Promise<void> {
    const r = this.githubResources.get(id);
    if (!r) return;
    this.githubResources.set(id, {
      ...r,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: this.clock.now(),
    });
  }

  async reclaimExpiredGitHubResourceLeases(
    now = this.clock.now(),
  ): Promise<number> {
    let count = 0;
    for (const [id, r] of this.githubResources) {
      if (
        r.leaseOwner != null &&
        r.leaseUntil != null &&
        r.leaseUntil <= now
      ) {
        this.githubResources.set(id, {
          ...r,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: now,
        });
        count += 1;
      }
    }
    return count;
  }

  async recordGitHubPollFailure(
    resourceId: string,
    error: string,
    nextPollAt: number,
  ): Promise<void> {
    const r = this.githubResources.get(resourceId);
    if (!r) return;
    const now = this.clock.now();
    this.githubResources.set(resourceId, {
      ...r,
      consecutiveFailures: r.consecutiveFailures + 1,
      lastError: error,
      lastPolledAt: now,
      nextPollAt,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    });
  }

  async registerPipelineGitHubResource(
    assoc: Omit<PipelineGitHubResource, "createdAt" | "updatedAt"> & {
      createdAt?: number;
      updatedAt?: number;
    },
  ): Promise<PipelineGitHubResource> {
    const now = this.clock.now();
    // UNIQUE(run_id, resource_id, role)
    for (const existing of this.pipelineGithub.values()) {
      if (
        existing.runId === assoc.runId &&
        existing.resourceId === assoc.resourceId &&
        existing.role === assoc.role
      ) {
        const updated: PipelineGitHubResource = {
          ...existing,
          workstreamKey: assoc.workstreamKey,
          attemptId: assoc.attemptId,
          registeredByAssignmentId: assoc.registeredByAssignmentId,
          expectedHeadSha: assoc.expectedHeadSha,
          active: assoc.active,
          updatedAt: now,
        };
        this.pipelineGithub.set(existing.id, updated);
        return { ...updated };
      }
    }
    const full: PipelineGitHubResource = {
      id: assoc.id,
      runId: assoc.runId,
      resourceId: assoc.resourceId,
      role: assoc.role,
      workstreamKey: assoc.workstreamKey,
      attemptId: assoc.attemptId,
      registeredByAssignmentId: assoc.registeredByAssignmentId,
      expectedHeadSha: assoc.expectedHeadSha,
      active: assoc.active,
      createdAt: assoc.createdAt ?? now,
      updatedAt: assoc.updatedAt ?? now,
    };
    this.pipelineGithub.set(full.id, full);
    return { ...full };
  }

  async listPipelineGitHubResources(
    runId: string,
    activeOnly = false,
  ): Promise<PipelineGitHubResource[]> {
    return [...this.pipelineGithub.values()]
      .filter((a) => a.runId === runId && (!activeOnly || a.active))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => ({ ...a }));
  }

  async listAssociationsForResource(
    resourceId: string,
    activeOnly = false,
  ): Promise<PipelineGitHubResource[]> {
    return [...this.pipelineGithub.values()]
      .filter((a) => a.resourceId === resourceId && (!activeOnly || a.active))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => ({ ...a }));
  }

  async deactivatePipelineGitHubResource(id: string): Promise<void> {
    const a = this.pipelineGithub.get(id);
    if (!a) return;
    this.pipelineGithub.set(id, {
      ...a,
      active: false,
      updatedAt: this.clock.now(),
    });
  }

  async commitPrRegistration(input: {
    registration: GitHubResourceRegistration;
    actorId: string;
    runPhase: string;
    now: number;
  }): Promise<{ eventId: string }> {
    const { registration, actorId, runPhase, now } = input;
    const idempotencyKey = `pr-reg:${registration.owner}/${registration.repo}#${registration.number}:${registration.role}:${registration.workstreamKey}`;
    const priorId = this.eventByIdempotency.get(idempotencyKey);
    if (priorId) {
      return { eventId: priorId };
    }

    const eventId = crypto.randomUUID();
    const events = this.events.get(registration.runId) ?? [];
    const full: PipelineEvent = {
      id: eventId,
      runId: registration.runId,
      sequence: events.length + 1,
      eventType: "github.pr.registered",
      actorType: "agent",
      actorId,
      assignmentId: registration.assignmentId,
      outcomeId: null,
      fromPhase: runPhase,
      toPhase: runPhase,
      payloadVersion: 1,
      payload: { ...registration },
      idempotencyKey,
      occurredAt: now,
      observedAt: now,
    };
    events.push(full);
    this.events.set(registration.runId, events);
    this.eventByIdempotency.set(idempotencyKey, eventId);

    let resourceId: string;
    const existing = [...this.githubResources.values()].find(
      (r) =>
        r.owner === registration.owner &&
        r.repo === registration.repo &&
        r.number === registration.number,
    );
    if (existing) {
      resourceId = existing.id;
    } else {
      resourceId = crypto.randomUUID();
      this.githubResources.set(resourceId, {
        id: resourceId,
        kind: "pull_request",
        owner: registration.owner,
        repo: registration.repo,
        number: registration.number,
        nodeId: null,
        snapshot: null,
        lastPolledAt: null,
        nextPollAt: now,
        pollClass: "warm",
        consecutiveFailures: 0,
        lastError: null,
        leaseOwner: null,
        leaseUntil: null,
        terminalAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const assocId = crypto.randomUUID();
    this.pipelineGithub.set(assocId, {
      id: assocId,
      runId: registration.runId,
      resourceId,
      role: registration.role,
      workstreamKey: registration.workstreamKey,
      attemptId: registration.attemptId,
      registeredByAssignmentId: registration.assignmentId,
      expectedHeadSha: registration.expectedHeadSha,
      active: true,
      createdAt: now,
      updatedAt: now,
    });

    return { eventId };
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
    const resource = this.githubResources.get(input.resourceId);
    if (!resource) {
      throw new Error(`github resource not found: ${input.resourceId}`);
    }
    const now = this.clock.now();
    const associations = [...this.pipelineGithub.values()].filter(
      (a) => a.resourceId === input.resourceId && a.active,
    );

    this.githubResources.set(input.resourceId, {
      ...resource,
      nodeId:
        input.nodeId !== undefined
          ? input.nodeId
          : resource.nodeId,
      snapshot: { ...input.snapshot },
      lastPolledAt: now,
      nextPollAt: input.nextPollAt,
      pollClass: input.pollClass ?? resource.pollClass,
      consecutiveFailures: 0,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      terminalAt:
        input.terminalAt !== undefined
          ? input.terminalAt
          : resource.terminalAt,
      updatedAt: now,
    });

    // Persist semantic events onto each active run association.
    // Never enqueue wake outbox items in Phase 5.
    for (const event of input.events) {
      for (const assoc of associations) {
        const idempotencyKey = `${event.fingerprint}:run:${assoc.runId}:role:${assoc.role}`;
        if (this.eventByIdempotency.has(idempotencyKey)) continue;
        const runEvents = this.events.get(assoc.runId) ?? [];
        const sequence = runEvents.length + 1;
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
            proposedReductions: input.proposedReductions.filter(
              (r) =>
                r.kind === "checks_apply_to_sha" ||
                (r.kind === "invalidate_aggregate_gates" &&
                  r.workstreamKey === assoc.workstreamKey) ||
                (r.kind === "role_specific_merge" && r.role === assoc.role),
            ),
            shadow: true,
            wakesDelivered: false,
          },
          idempotencyKey,
          occurredAt: event.observedAt,
          observedAt: now,
        };
        runEvents.push(full);
        this.events.set(assoc.runId, runEvents);
        this.eventByIdempotency.set(idempotencyKey, full.id);
      }
    }

    return {
      resourceId: input.resourceId,
      events: input.events.map((e) => ({ ...e })),
      proposedReductions: input.proposedReductions.map((r) => ({ ...r })),
      wakesDelivered: false,
      associationsTouched: associations.length,
    };
  }

  // -------------------------------------------------------------------------
  // Dev-server jobs (Phase 6)
  // -------------------------------------------------------------------------

  async createDevServerJob(job: DevServerJobCreate): Promise<DevServerJob> {
    const key = `${job.assignmentId}#${job.repo}`;
    const existingId = this.devServerJobsByAssignment.get(key);
    if (existingId) {
      const existing = this.devServerJobs.get(existingId);
      if (existing) return { ...existing };
    }
    if (this.devServerJobs.has(job.id)) {
      throw new Error(`dev server job already exists: ${job.id}`);
    }
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
    this.devServerJobs.set(full.id, full);
    this.devServerJobsByAssignment.set(key, full.id);
    // Also index bare assignment for single-repo getByAssignment callers.
    this.devServerJobsByAssignment.set(full.assignmentId, full.id);
    return { ...full };
  }

  async getDevServerJob(id: string): Promise<DevServerJob | undefined> {
    const j = this.devServerJobs.get(id);
    return j ? { ...j } : undefined;
  }

  async getDevServerJobByAssignment(
    assignmentId: string,
  ): Promise<DevServerJob | undefined> {
    const id = this.devServerJobsByAssignment.get(assignmentId);
    if (!id) return undefined;
    return this.getDevServerJob(id);
  }

  async listDevServerJobs(filter?: {
    runId?: string;
    status?: DevServerJobStatus | DevServerJobStatus[];
  }): Promise<DevServerJob[]> {
    const statuses = filter?.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : null;
    return [...this.devServerJobs.values()]
      .filter((j) => {
        if (filter?.runId && j.runId !== filter.runId) return false;
        if (statuses && !statuses.has(j.status)) return false;
        return true;
      })
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((j) => ({ ...j }));
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
    const j = this.devServerJobs.get(id);
    if (!j) return undefined;
    if (isTerminalDevServerStatus(j.status)) {
      return { ...j };
    }
    const updated: DevServerJob = {
      ...j,
      ...patch,
      updatedAt: this.clock.now(),
    };
    this.devServerJobs.set(id, updated);
    return { ...updated };
  }

  async releaseDevServerJob(
    id: string,
    reason: string,
    error?: string | null,
  ): Promise<boolean> {
    const j = this.devServerJobs.get(id);
    if (!j) return false;
    if (isTerminalDevServerStatus(j.status)) return false;
    const status = releaseStatusForReason(reason);
    this.devServerJobs.set(id, {
      ...j,
      status,
      error: error ?? j.error,
      releasedAt: this.clock.now(),
      releaseReason: reason,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: this.clock.now(),
    });
    return true;
  }

  async reclaimExpiredDevServerJobs(now = this.clock.now()): Promise<number> {
    let count = 0;
    for (const [id, j] of this.devServerJobs) {
      if (
        j.status === "acquiring" &&
        j.leaseExpiresAt != null &&
        j.leaseExpiresAt <= now
      ) {
        this.devServerJobs.set(id, {
          ...j,
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        });
        count += 1;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Thread catch-up cursors
  // -------------------------------------------------------------------------

  async getThreadCursor(
    runId: string,
  ): Promise<PipelineThreadCursor | undefined> {
    const c = this.threadCursors.get(runId);
    return c ? { ...c } : undefined;
  }

  async upsertThreadCursor(cursor: PipelineThreadCursor): Promise<void> {
    this.threadCursors.set(cursor.runId, { ...cursor });
  }

  async listThreadCursors(filter?: {
    waitingRunsOnly?: boolean;
  }): Promise<PipelineThreadCursor[]> {
    const all = [...this.threadCursors.values()];
    if (!filter?.waitingRunsOnly) {
      return all.map((c) => ({ ...c }));
    }
    return all
      .filter((c) => {
        const run = this.runs.get(c.runId);
        return run != null && run.status === "waiting";
      })
      .map((c) => ({ ...c }));
  }
}

function coordsKey(owner: string, repo: string, number: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

function cloneGitHubResource(r: GitHubResource): GitHubResource {
  return {
    ...r,
    snapshot: r.snapshot ? { ...r.snapshot } : null,
  };
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
