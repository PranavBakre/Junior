import type {
  GitHubResource,
  GitHubSemanticEvent,
  PipelineGitHubResource,
  PrSnapshot,
  ProposedReduction,
  ShadowPersistResult,
  GitHubPollClass,
} from "../../github/types.ts";
import type {
  Assignment,
  AssignmentCreate,
  AttemptRevisionMember,
  DevServerJob,
  DevServerJobCreate,
  DevServerJobStatus,
  PipelineAttempt,
  PipelineEvent,
  PipelineGate,
  PipelineOutboxRecord,
  PipelineRun,
  PipelineThreadCursor,
  RecordOutcomeInput,
  StoredOutcome,
  TransitionReceipt,
  OutboxCreate,
} from "../types.ts";

export interface PipelineStore {
  createRun(run: PipelineRun): Promise<void>;
  getRun(id: string): Promise<PipelineRun | undefined>;
  getRunByThread(threadId: string): Promise<PipelineRun | undefined>;

  createAssignment(assignment: AssignmentCreate): Promise<Assignment>;
  getAssignment(id: string): Promise<Assignment | undefined>;
  listAssignments(runId: string): Promise<Assignment[]>;

  /**
   * Atomic: validate policy + transition, persist outcome, update assignment
   * and run (CAS on state_version), append event, enqueue outbox successor.
   */
  recordOutcomeTransaction(input: RecordOutcomeInput): Promise<TransitionReceipt>;

  appendEvent(event: Omit<PipelineEvent, "sequence"> & { sequence?: number }): Promise<PipelineEvent>;
  listEvents(runId: string): Promise<PipelineEvent[]>;

  enqueueOutbox(record: OutboxCreate): Promise<PipelineOutboxRecord>;
  claimOutbox(
    owner: string,
    limit: number,
    leaseMs: number,
  ): Promise<PipelineOutboxRecord[]>;
  markOutboxDelivered(id: string): Promise<void>;
  reclaimExpiredOutboxLeases(now?: number): Promise<number>;
  listOutbox(runId: string): Promise<PipelineOutboxRecord[]>;

  /**
   * Terminal runs eligible for retention GC (status=terminal and
   * updated_at <= updatedBefore when provided). Never returns active runs.
   */
  listTerminalRuns(filter?: {
    updatedBefore?: number;
  }): Promise<PipelineRun[]>;

  /**
   * Compact verbose history for a terminal run only: clear delivered outbox
   * payloads and strip verbose event payloads. No-ops (and returns zeros)
   * when the run is missing or non-terminal.
   */
  compactTerminalRunHistory(runId: string): Promise<{
    outboxCompacted: number;
    eventsCompacted: number;
  }>;

  createAttempt(attempt: PipelineAttempt): Promise<void>;
  getAttempt(id: string): Promise<PipelineAttempt | undefined>;
  /**
   * Replace the attempt revision vector. When the digest changes, all
   * aggregate gates for the attempt are invalidated.
   */
  replaceAttemptRevision(
    attemptId: string,
    members: AttemptRevisionMember[],
  ): Promise<{ digest: string; invalidatedGateCount: number }>;
  listRevisionMembers(attemptId: string): Promise<AttemptRevisionMember[]>;

  upsertGate(gate: PipelineGate): Promise<void>;
  listGates(attemptId: string): Promise<PipelineGate[]>;

  listOutcomes(assignmentId: string): Promise<StoredOutcome[]>;

  // -------------------------------------------------------------------------
  // GitHub resource tracking (Phase 5 shadow — no wakes)
  // -------------------------------------------------------------------------

  upsertGitHubResource(resource: GitHubResource): Promise<void>;
  getGitHubResource(id: string): Promise<GitHubResource | undefined>;
  getGitHubResourceByCoords(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubResource | undefined>;
  listActiveTrackedResources(): Promise<GitHubResource[]>;
  listDueGitHubResources(now: number, limit?: number): Promise<GitHubResource[]>;
  claimGitHubResourceLease(
    id: string,
    owner: string,
    leaseMs: number,
    now?: number,
  ): Promise<boolean>;
  releaseGitHubResourceLease(id: string): Promise<void>;
  /** Clear GitHub resource leases whose lease_until has passed. */
  reclaimExpiredGitHubResourceLeases(now?: number): Promise<number>;
  recordGitHubPollFailure(
    resourceId: string,
    error: string,
    nextPollAt: number,
  ): Promise<void>;

  registerPipelineGitHubResource(
    assoc: Omit<PipelineGitHubResource, "createdAt" | "updatedAt"> & {
      createdAt?: number;
      updatedAt?: number;
    },
  ): Promise<PipelineGitHubResource>;
  listPipelineGitHubResources(
    runId: string,
    activeOnly?: boolean,
  ): Promise<PipelineGitHubResource[]>;
  listAssociationsForResource(
    resourceId: string,
    activeOnly?: boolean,
  ): Promise<PipelineGitHubResource[]>;
  deactivatePipelineGitHubResource(id: string): Promise<void>;

  /**
   * Atomically persist snapshot + semantic events for active run associations.
   * When wakeEnabled is false (default / Phase 5), never enqueues wake outbox
   * items. When true (Phase 6 + flags), still only persists events — the bug
   * controller reduces them into wakes via reduceGitHubEventsForWakes.
   */
  applyGitHubSnapshotShadow(input: {
    resourceId: string;
    snapshot: PrSnapshot;
    nodeId?: string | null;
    events: GitHubSemanticEvent[];
    proposedReductions: ProposedReduction[];
    nextPollAt: number;
    pollClass?: GitHubPollClass;
    terminalAt?: number | null;
    /** Reserved: controller owns wake delivery. Always persisted as shadow. */
    wakeEnabled?: boolean;
  }): Promise<ShadowPersistResult>;

  // -------------------------------------------------------------------------
  // Dev-server jobs (Phase 6 durable readiness)
  // -------------------------------------------------------------------------

  createDevServerJob(job: DevServerJobCreate): Promise<DevServerJob>;
  getDevServerJob(id: string): Promise<DevServerJob | undefined>;
  getDevServerJobByAssignment(
    assignmentId: string,
  ): Promise<DevServerJob | undefined>;
  listDevServerJobs(filter?: {
    runId?: string;
    status?: DevServerJobStatus | DevServerJobStatus[];
  }): Promise<DevServerJob[]>;
  updateDevServerJob(
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
  ): Promise<DevServerJob | undefined>;
  /**
   * Idempotent release. Returns true when this call transitioned the job to a
   * terminal status; false when already terminal.
   */
  releaseDevServerJob(
    id: string,
    reason: string,
    error?: string | null,
  ): Promise<boolean>;
  reclaimExpiredDevServerJobs(now?: number): Promise<number>;

  // -------------------------------------------------------------------------
  // Slack thread catch-up cursors (waiting runs)
  // -------------------------------------------------------------------------

  getThreadCursor(runId: string): Promise<PipelineThreadCursor | undefined>;
  upsertThreadCursor(cursor: PipelineThreadCursor): Promise<void>;
  listThreadCursors(filter?: {
    waitingRunsOnly?: boolean;
  }): Promise<PipelineThreadCursor[]>;

  close?(): void;
}
