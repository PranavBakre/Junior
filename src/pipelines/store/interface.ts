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
  PipelineAttempt,
  PipelineEvent,
  PipelineGate,
  PipelineOutboxRecord,
  PipelineRun,
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
   * Never enqueues wake outbox items (Phase 5 shadow contract).
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
  }): Promise<ShadowPersistResult>;

  close?(): void;
}
