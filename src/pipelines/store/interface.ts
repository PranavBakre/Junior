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

  close?(): void;
}
