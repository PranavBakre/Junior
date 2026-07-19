/**
 * GitHub resource tracking types for Phase 5 shadow reconciliation.
 * Semantic events are persisted without waking agents until Phase 6.
 */

/** Hot poll interval while waiting on review / checks / merge. */
export const GITHUB_POLL_HOT_MS = 30_000;
/** Warm poll interval for human-gated or less urgent resources. */
export const GITHUB_POLL_WARM_MS = 120_000;
/** Maximum backoff after rate limits / failures (15 minutes). */
export const GITHUB_BACKOFF_CEILING_MS = 15 * 60_000;

export type GitHubResourceKind = "pull_request";
export type GitHubPollClass = "hot" | "warm";

export type PrReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | "DISMISSED"
  | null;

export type PrCheckRollupState =
  | "SUCCESS"
  | "FAILURE"
  | "PENDING"
  | "ERROR"
  | "EXPECTED"
  | null;

export type PrMergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;

export type PrLifecycleState = "OPEN" | "CLOSED" | "MERGED";

/**
 * Durable PR observation snapshot. Checks are tracked via the head commit
 * rollup — do not rely only on PR `updatedAt`.
 */
export type PrSnapshot = {
  state: PrLifecycleState;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviewDecision: PrReviewDecision;
  mergeable: PrMergeableState;
  mergedAt: string | null;
  closedAt: string | null;
  /** Aggregate check rollup for the head commit. */
  checkRollup: PrCheckRollupState;
  /** Head SHA the check rollup applies to. */
  checkRollupSha: string | null;
  updatedAt: string | null;
};

export type GitHubSemanticEventType =
  | "github.pr.head_changed"
  | "github.pr.base_changed"
  | "github.pr.review_decision_changed"
  | "github.pr.checks_changed"
  | "github.pr.closed"
  | "github.pr.reopened"
  | "github.pr.merged";

export type GitHubSemanticEvent = {
  type: GitHubSemanticEventType;
  resourceId: string;
  owner: string;
  repo: string;
  number: number;
  observedAt: number;
  previous: Partial<PrSnapshot> | null;
  next: Partial<PrSnapshot>;
  /** Stable fingerprint for idempotent event insertion. */
  fingerprint: string;
};

/**
 * Shadow-mode reduction proposals. Controllers map these in Phase 6;
 * Phase 5 only persists them.
 */
export type ProposedReduction =
  | {
      kind: "invalidate_aggregate_gates";
      reason: "head_changed";
      resourceId: string;
      attemptId: string | null;
      workstreamKey: string;
      previousHeadSha: string;
      nextHeadSha: string;
    }
  | {
      kind: "checks_apply_to_sha";
      resourceId: string;
      headSha: string;
      checkRollup: PrCheckRollupState;
    }
  | {
      kind: "role_specific_merge";
      resourceId: string;
      role: PipelineGitHubResourceRole;
      headSha: string;
    };

export type GitHubResource = {
  id: string;
  kind: GitHubResourceKind;
  owner: string;
  repo: string;
  number: number;
  nodeId: string | null;
  snapshot: PrSnapshot | null;
  lastPolledAt: number | null;
  nextPollAt: number;
  pollClass: GitHubPollClass;
  consecutiveFailures: number;
  lastError: string | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  terminalAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PipelineGitHubResourceRole =
  | "candidate"
  | "dev-pr"
  | "main-pr"
  | "dependency"
  | "review-target";

export type PipelineGitHubResource = {
  id: string;
  runId: string;
  resourceId: string;
  role: PipelineGitHubResourceRole;
  workstreamKey: string;
  attemptId: string | null;
  registeredByAssignmentId: string | null;
  expectedHeadSha: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ShadowPersistResult = {
  resourceId: string;
  events: GitHubSemanticEvent[];
  proposedReductions: ProposedReduction[];
  /** Always false in Phase 5 — wakes are not delivered. */
  wakesDelivered: false;
  associationsTouched: number;
};

export type DriftDiscoveryResult =
  | { status: "found"; owner: string; repo: string; number: number; nodeId: string | null }
  | { status: "none" }
  | { status: "ambiguous"; candidates: Array<{ number: number; url: string }> }
  | { status: "error"; message: string };
