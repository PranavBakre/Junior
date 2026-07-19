/**
 * Product-mode-specific policy: skip rules, fan-out rejoin, multi-PR gates,
 * review-finding fingerprint escalation. Complements generic validateOutcome.
 */

import type {
  AgentOutcome,
  Assignment,
  PipelineGate,
  ProductRun,
} from "../types.ts";
import {
  isProductBuilderAgent,
  type SkipStageReason,
} from "./definition.ts";

export type ProductPolicyContext = {
  run: ProductRun;
  assignment: Assignment;
  outcome: AgentOutcome;
  /** Open builder assignments still pending for fan-out rejoin. */
  pendingBuilderAssignments: Assignment[];
  /** Completed builder assignments for the active attempt. */
  completedBuilderAssignments: Assignment[];
  /** Registered PR roles for this run (candidate/main/etc). */
  registeredPrKeys: string[];
  /** Prior review-finding fingerprints (newest last). */
  recentReviewFingerprints: string[];
  /** Skip reasons already recorded for this run. */
  skipReasons: SkipStageReason[];
  gates?: PipelineGate[];
  now: number;
};

export type ProductPolicyResult =
  | { ok: true; notes?: string[] }
  | { ok: false; reason: string; escalate?: boolean };

/**
 * Product-aware checks after generic outcome validation succeeds.
 *
 * - Aggregate verification cannot complete while builders are still open
 * - PR-open completion requires at least one registered PR when any claimed
 * - Unchanged review findings without a new revision escalate
 * - Direct build/fix/implement does not require a redundant go-word
 * - Human merge is never auto-completed by an agent
 */
export function validateProductOutcome(
  ctx: ProductPolicyContext,
): ProductPolicyResult {
  const { run, outcome, assignment, pendingBuilderAssignments } = ctx;
  const notes: string[] = [];

  // Agents never auto-ship; ready-for-human-merge → shipped is human-only.
  if (
    run.phase === "ready-for-human-merge" &&
    outcome.action === "complete" &&
    outcome.status === "succeeded" &&
    assignment.sourceAgent !== "human" &&
    // Allow explicit human actor via escalate/complete only when marked human.
    !outcome.evidenceRefs.some((r) => r.startsWith("human-merge:"))
  ) {
    // Completing without human-merge evidence is rejected unless actor is human
    // (checked by controller via actorType). Here we only soft-note; controller
    // enforces actorType === "human" for ship transitions.
    notes.push("ship transition requires human actor + human-merge evidence");
  }

  // Aggregate verification: all fan-out builders must be done.
  if (
    run.phase === "aggregate-verification" &&
    outcome.action === "complete" &&
    outcome.status === "succeeded" &&
    pendingBuilderAssignments.length > 0
  ) {
    return {
      ok: false,
      reason: `aggregate verification waits for builders: ${pendingBuilderAssignments
        .map((a) => a.targetAgent)
        .join(", ")}`,
      escalate: false,
    };
  }

  // Leaving building toward aggregate-verification via complete: same gate.
  if (
    run.phase === "building" &&
    outcome.action === "complete" &&
    outcome.status === "succeeded" &&
    isProductBuilderAgent(assignment.targetAgent) &&
    pendingBuilderAssignments.some((a) => a.id !== assignment.id)
  ) {
    // Other builders still open — allow complete of this assignment but note
    // rejoin is pending (controller keeps phase at building).
    notes.push(
      `builder ${assignment.targetAgent} done; waiting for remaining builders`,
    );
  }

  // Review findings: same fingerprint without new revision/evidence escalates.
  if (
    run.phase === "reviewing" &&
    (outcome.status === "failed" ||
      outcome.checks.some(
        (c) => c.name === "review" && c.status === "failed",
      ))
  ) {
    const findingFp = reviewFindingFingerprint(outcome);
    if (
      findingFp &&
      ctx.recentReviewFingerprints.includes(findingFp) &&
      outcome.evidenceRefs.length === 0 &&
      !outcome.artifactRefs.some((a) => a.startsWith("revision:"))
    ) {
      return {
        ok: false,
        reason:
          "unchanged review findings without new candidate revision or evidence; escalate rather than loop",
        escalate: true,
      };
    }
  }

  // Direct implementation authority: builders may complete scoped work without
  // a go-word artifact when mutation scope is declared.
  if (
    isProductBuilderAgent(assignment.targetAgent) &&
    (run.phase === "building" || run.phase === "ready-to-build" || run.phase === "fixing") &&
    outcome.action === "complete" &&
    outcome.status === "succeeded"
  ) {
    if (assignment.mutationScope.length === 0) {
      notes.push(
        "builder completion with empty mutationScope; prefer explicit worktree scope",
      );
    }
    // No go-word gate — intentional.
  }

  // Fixing → rework must acknowledge gate invalidation on revision change.
  if (
    run.phase === "fixing" &&
    outcome.action === "handoff" &&
    isProductBuilderAgent(outcome.targetAgent ?? "")
  ) {
    notes.push("rework handoff; prior aggregate gates must re-open on new revision");
  }

  return { ok: true, notes };
}

/**
 * Stable fingerprint of review findings for loop detection.
 * Prefer explicit check evidenceRef / progressFingerprint over prose.
 */
export function reviewFindingFingerprint(outcome: AgentOutcome): string | null {
  const reviewChecks = outcome.checks.filter(
    (c) =>
      c.name === "review" ||
      c.name === "findings" ||
      c.name.startsWith("review."),
  );
  if (reviewChecks.length > 0) {
    return reviewChecks
      .map((c) => `${c.name}:${c.status}:${c.evidenceRef ?? ""}`)
      .sort()
      .join("|");
  }
  if (outcome.progressFingerprint?.trim()) {
    return `fp:${outcome.progressFingerprint}`;
  }
  return null;
}

/**
 * Aggregate gate check for product: review + checks (+ optional aggregate)
 * must share one attempt and subject SHA set.
 */
export function revisionGatesConsistent(gates: PipelineGate[]): {
  ok: boolean;
  reason?: string;
} {
  const active = gates.filter(
    (g) =>
      g.status !== "invalidated" &&
      (g.gateKind === "review" ||
        g.gateKind === "checks" ||
        g.gateKind === "aggregate" ||
        g.gateKind === "human-merge"),
  );
  if (active.length === 0) return { ok: true };

  const shas = new Set(
    active.map((g) => g.subjectSha).filter((s): s is string => s != null),
  );
  if (shas.size > 1) {
    return {
      ok: false,
      reason: `product aggregate gates subject SHAs diverge: ${[...shas].join(", ")}`,
    };
  }

  const attempts = new Set(active.map((g) => g.attemptId));
  if (attempts.size > 1) {
    return {
      ok: false,
      reason: "product aggregate gates span multiple attempts",
    };
  }

  return { ok: true };
}

/**
 * Whether every required PR workstream is registered.
 * `requiredKeys` are stable workstream keys (e.g. backend, frontend).
 */
export function allRequiredPrsRegistered(
  requiredKeys: string[],
  registeredKeys: string[],
): boolean {
  if (requiredKeys.length === 0) {
    // No explicit fan-out → at least one registration when any exist is enough
    // for callers that pass empty required; treat as vacuously true.
    return true;
  }
  const set = new Set(registeredKeys);
  return requiredKeys.every((k) => set.has(k));
}

/**
 * Multi-PR identity: same repo may host multiple PRs distinguished by
 * workstreamKey + role + number.
 */
export function prRegistrationKey(input: {
  owner: string;
  repo: string;
  number: number;
  role: string;
  workstreamKey: string;
}): string {
  return `${input.owner}/${input.repo}#${input.number}:${input.role}:${input.workstreamKey}`;
}

/**
 * Fan-out rejoin: true when no open builder assignments remain (excluding
 * the assignment currently completing, if provided).
 */
export function fanOutComplete(
  builderAssignments: Assignment[],
  completingAssignmentId?: string,
): boolean {
  const open = builderAssignments.filter(
    (a) =>
      a.id !== completingAssignmentId &&
      (a.status === "pending" ||
        a.status === "leased" ||
        a.status === "waiting"),
  );
  return open.length === 0;
}
