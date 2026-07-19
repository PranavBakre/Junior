/**
 * Canonical, versioned runtime contracts for ProductRun / BugRun control plane.
 * Phase 2 substrate — not wired into live Slack routing yet.
 */

/** Bump only when the controller contract itself changes incompatibly. */
export const PIPELINE_DEFINITION_VERSION = 1;

export type PipelineKind = "product" | "bug";

export type PipelineRunStatus =
  | "active"
  | "waiting"
  | "needs-human"
  | "terminal";

export type TerminalOutcome =
  | "merged"
  | "shipped"
  | "expected-behavior"
  | "not-reproduced"
  | "abandoned"
  | null;

// ---------------------------------------------------------------------------
// Phases — explicit unions; models must not invent arbitrary phase strings.
// ---------------------------------------------------------------------------

export type ProductPhase =
  | "discovery"
  | "spec-drafting"
  | "awaiting-product-decision"
  | "ready-to-build"
  | "building"
  | "aggregate-verification"
  | "pr-open"
  | "reviewing"
  | "fixing"
  | "approved"
  | "ready-for-human-merge"
  | "shipped"
  | "needs-human"
  | "abandoned";

export type BugPhase =
  | "intake"
  | "evidence"
  | "diagnosis"
  | "risk-gate"
  | "fixing"
  | "reviewing"
  | "validating"
  | "checks"
  | "dev-merge"
  | "main-merge-gate"
  | "merged"
  | "cleanup"
  | "expected-behavior"
  | "not-reproduced"
  | "needs-human"
  | "abandoned";

export type PipelinePhase = ProductPhase | BugPhase;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type PipelineRunBase = {
  id: string;
  kind: PipelineKind;
  definitionVersion: number;
  channelId: string;
  threadId: string;
  phase: string;
  status: PipelineRunStatus;
  ownerAgent: string;
  repoRefs: string[];
  acceptanceCriteria: string[];
  artifactRefs: string[];
  blockerRefs: string[];
  activeAttemptId: string | null;
  stateVersion: number;
  deadlineAt: number | null;
  terminalOutcome: TerminalOutcome;
  terminalReason: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ProductRun = Omit<PipelineRunBase, "kind" | "phase"> & {
  kind: "product";
  phase: ProductPhase;
};

export type BugRun = Omit<PipelineRunBase, "kind" | "phase"> & {
  kind: "bug";
  phase: BugPhase;
};

export type PipelineRun = ProductRun | BugRun;

// ---------------------------------------------------------------------------
// Attempt revision vectors
// ---------------------------------------------------------------------------

export type AttemptRevisionMember = {
  memberKey: string;
  repoRef: string;
  branch: string;
  headSha: string;
  githubResourceId?: string;
};

export type AttemptStatus =
  | "open"
  | "gates-pending"
  | "gates-passed"
  | "invalidated"
  | "closed";

export type PipelineAttempt = {
  id: string;
  runId: string;
  ordinal: number;
  revisionDigest: string | null;
  status: AttemptStatus;
  invalidatedAt: number | null;
  invalidationReason: string | null;
  createdAt: number;
  finishedAt: number | null;
};

export type GateKind =
  | "review"
  | "validation"
  | "checks"
  | "aggregate"
  | "human-merge";

export type GateStatus = "pending" | "passed" | "failed" | "invalidated" | "skipped";

export type PipelineGate = {
  id: string;
  runId: string;
  attemptId: string;
  memberKey: string | null;
  githubResourceId: string | null;
  gateKind: GateKind;
  status: GateStatus;
  subjectSha: string | null;
  evidenceRef: string | null;
  provider: string | null;
  model: string | null;
  agentName: string | null;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Assignments & outcomes
// ---------------------------------------------------------------------------

export type AssignmentStatus =
  | "pending"
  | "leased"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting";

export type Assignment = {
  id: string;
  runId: string;
  parentAssignmentId: string | null;
  sourceAgent: string | "human" | "system";
  targetAgent: string;
  status: AssignmentStatus;
  objective: string;
  contextRefs: string[];
  artifactRefs: string[];
  acceptanceCriteria: string[];
  mutationScope: string[];
  dependsOn: string[];
  attempt: number;
  attemptId: string | null;
  candidateRevisionDigest: string | null;
  deadlineAt: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
};

/** Input shape when creating an assignment (store fills timestamps / defaults). */
export type AssignmentCreate = Omit<
  Assignment,
  "status" | "leaseOwner" | "leaseExpiresAt" | "createdAt" | "updatedAt"
> & {
  status?: AssignmentStatus;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
};

export type OutcomeAction =
  | "continue_self"
  | "handoff"
  | "wait"
  | "escalate"
  | "complete";

export type OutcomeStatus =
  | "progress"
  | "succeeded"
  | "expected_behavior"
  | "not_reproduced"
  | "blocked"
  | "failed";

export type BlockerKind =
  | "missing_context"
  | "missing_authority"
  | "human_gate"
  | "unsafe_mutation"
  | "conflicting_evidence"
  | "no_progress"
  | "infra_failure";

export type AgentOutcome = {
  assignmentId: string;
  expectedRunVersion: number;
  action: OutcomeAction;
  status: OutcomeStatus;
  targetAgent?: string;
  reason: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  blockers: Array<{ kind: BlockerKind; detail: string }>;
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
    evidenceRef?: string;
  }>;
  /** Diagnostic only — never sufficient to satisfy a runtime gate. */
  confidence?: number;
  progressFingerprint: string;
  /**
   * Required for action === "wait". Named condition + deadline; no indefinite
   * prose-only waiting.
   */
  wait?: {
    conditionName: string;
    deadlineAt: number;
  };
  nextAssignment?: Omit<
    AssignmentCreate,
    "id" | "runId" | "sourceAgent"
  > & { id?: string };
};

export type StoredOutcome = {
  id: string;
  assignmentId: string;
  action: OutcomeAction;
  status: OutcomeStatus;
  reason: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  blockers: AgentOutcome["blockers"];
  checks: AgentOutcome["checks"];
  confidence: number | null;
  progressFingerprint: string;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// GitHub registration (typed for later phases; stored as event payload now)
// ---------------------------------------------------------------------------

export type GitHubResourceRegistration = {
  runId: string;
  assignmentId: string;
  owner: string;
  repo: string;
  number: number;
  role: "candidate" | "dev-pr" | "main-pr" | "dependency" | "review-target";
  workstreamKey: string;
  attemptId: string | null;
  expectedHeadSha: string;
};

// ---------------------------------------------------------------------------
// Receipts, events, outbox
// ---------------------------------------------------------------------------

export type TransitionReceipt = {
  status:
    | "accepted"
    | "buffered"
    | "rejected"
    | "waiting"
    | "escalated"
    | "duplicate";
  runVersion: number;
  assignmentId?: string;
  reason?: string;
  outcomeId?: string;
  eventId?: string;
};

export type PipelineEvent = {
  id: string;
  runId: string;
  sequence: number;
  eventType: string;
  actorType: "agent" | "human" | "system";
  actorId: string;
  assignmentId: string | null;
  outcomeId: string | null;
  fromPhase: string | null;
  toPhase: string | null;
  payloadVersion: number;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  occurredAt: number;
  observedAt: number;
};

export type OutboxStatus =
  | "pending"
  | "leased"
  | "delivered"
  | "failed"
  | "dead";

export type PipelineOutboxRecord = {
  id: string;
  runId: string;
  assignmentId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  availableAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  idempotencyKey: string;
  createdAt: number;
  deliveredAt: number | null;
  lastError: string | null;
};

export type OutboxCreate = Omit<
  PipelineOutboxRecord,
  | "status"
  | "attempts"
  | "availableAt"
  | "leaseOwner"
  | "leaseExpiresAt"
  | "createdAt"
  | "deliveredAt"
  | "lastError"
> & {
  status?: OutboxStatus;
  attempts?: number;
  availableAt?: number;
};

/** Input to the atomic outcome transaction. */
export type RecordOutcomeInput = {
  outcome: AgentOutcome;
  /** Proposed phase advance. Omitted means keep current phase. */
  toPhase?: PipelinePhase | string;
  actorType: "agent" | "human" | "system";
  actorId: string;
  /** Optional event idempotency key for duplicate detection. */
  idempotencyKey?: string;
};
