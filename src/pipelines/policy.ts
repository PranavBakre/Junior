import type {
  AgentOutcome,
  Assignment,
  PipelineRun,
  TransitionReceipt,
} from "./types.ts";
import { isTerminalPhase } from "./transitions.ts";

export type PolicyContext = {
  run: PipelineRun;
  assignment: Assignment;
  outcome: AgentOutcome;
  /** Prior progress fingerprints for this assignment/run (newest last). */
  recentFingerprints: string[];
  now: number;
};

export type PolicyResult =
  | {
      ok: true;
      receiptStatus: Extract<
        TransitionReceipt["status"],
        "accepted" | "waiting" | "escalated"
      >;
    }
  | {
      ok: false;
      receiptStatus: Extract<
        TransitionReceipt["status"],
        "rejected" | "escalated"
      >;
      reason: string;
    };

/**
 * Pure outcome policy validator.
 *
 * Simplified but real subset of the control-plane rules:
 * - terminal runs reject mutation
 * - missing_authority always escalates
 * - wait requires named condition + deadline
 * - repeated progress fingerprint without new evidence escalates
 * - handoff requires targetAgent
 * - continue/complete/escalate shape checks
 */
export function validateOutcome(ctx: PolicyContext): PolicyResult {
  const { run, assignment, outcome, recentFingerprints, now } = ctx;

  if (run.status === "terminal" || isTerminalPhase(run.kind, run.phase)) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "terminal run is immutable",
    };
  }

  if (assignment.status === "completed" || assignment.status === "cancelled") {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: `assignment is already ${assignment.status}`,
    };
  }

  if (outcome.expectedRunVersion !== run.stateVersion) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: `state version conflict: expected ${outcome.expectedRunVersion}, actual ${run.stateVersion}`,
    };
  }

  if (!outcome.reason?.trim()) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "outcome.reason is required",
    };
  }

  if (!outcome.progressFingerprint?.trim()) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "outcome.progressFingerprint is required",
    };
  }

  const hasMissingAuthority = outcome.blockers.some(
    (b) => b.kind === "missing_authority",
  );
  if (hasMissingAuthority && outcome.action !== "escalate") {
    return {
      ok: false,
      receiptStatus: "escalated",
      reason: "missing_authority requires escalate",
    };
  }

  if (isFingerprintRepeat(outcome, recentFingerprints)) {
    return {
      ok: false,
      receiptStatus: "escalated",
      reason:
        "progress fingerprint repeated without new evidence or candidate revision",
    };
  }

  switch (outcome.action) {
    case "wait":
      return validateWait(outcome, now);
    case "delegate":
    case "handoff":
      return validateHandoff(outcome);
    case "escalate":
      return { ok: true, receiptStatus: "escalated" };
    case "continue_self":
    case "complete":
      return { ok: true, receiptStatus: "accepted" };
    default: {
      const _exhaustive: never = outcome.action;
      return {
        ok: false,
        receiptStatus: "rejected",
        reason: `unknown action: ${String(_exhaustive)}`,
      };
    }
  }
}

function validateWait(outcome: AgentOutcome, now: number): PolicyResult {
  const wait = outcome.wait;
  if (!wait?.conditionName?.trim()) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "wait requires wait.conditionName",
    };
  }
  if (
    typeof wait.deadlineAt !== "number" ||
    !Number.isFinite(wait.deadlineAt)
  ) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "wait requires wait.deadlineAt",
    };
  }
  if (wait.deadlineAt <= now) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "wait.deadlineAt must be in the future",
    };
  }
  return { ok: true, receiptStatus: "waiting" };
}

function validateHandoff(outcome: AgentOutcome): PolicyResult {
  if (!outcome.targetAgent?.trim()) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "handoff requires targetAgent",
    };
  }
  if (!outcome.nextAssignment) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "handoff requires nextAssignment",
    };
  }
  if (outcome.nextAssignment.targetAgent !== outcome.targetAgent) {
    return {
      ok: false,
      receiptStatus: "rejected",
      reason: "nextAssignment.targetAgent must match outcome.targetAgent",
    };
  }
  return { ok: true, receiptStatus: "accepted" };
}

/**
 * Same fingerprint repeating is only allowed when the outcome also carries
 * new evidence refs (evidence revision). Callers pass prior fingerprints.
 */
function isFingerprintRepeat(
  outcome: AgentOutcome,
  recentFingerprints: string[],
): boolean {
  if (recentFingerprints.length === 0) return false;
  const last = recentFingerprints[recentFingerprints.length - 1];
  if (last !== outcome.progressFingerprint) return false;
  // Unchanged fingerprint with zero new evidence → no progress.
  return outcome.evidenceRefs.length === 0;
}
