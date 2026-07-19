/**
 * Bug-mode-specific evidence and escalation policy.
 * Complements the generic validateOutcome in src/pipelines/policy.ts.
 */

import type {
  AgentOutcome,
  Assignment,
  BugRun,
  PipelineGate,
} from "../types.ts";
import {
  evidencePlanForMode,
  modePolicy,
  type BugMode,
  type EvidenceKind,
  type RiskClass,
} from "./definition.ts";

export type BugPolicyContext = {
  run: BugRun;
  mode: BugMode;
  assignment: Assignment;
  outcome: AgentOutcome;
  /** Evidence kinds already recorded for this run (from prior outcomes). */
  knownEvidence: EvidenceKind[];
  /** Evidence kinds explicitly skipped with reasons. */
  skippedEvidence: Array<{ kind: EvidenceKind; reason: string }>;
  riskClass?: RiskClass;
  gates?: PipelineGate[];
  now: number;
};

export type BugPolicyResult =
  | { ok: true; notes?: string[] }
  | { ok: false; reason: string; escalate?: boolean };

/**
 * Mode-aware checks after generic outcome validation succeeds.
 *
 * - expected-behavior may complete without code mutations
 * - focused/full require proportional evidence before leaving diagnosis
 * - high-risk classes escalate to human gate inside full-investigation
 * - write-path validation cannot pass on review alone
 */
export function validateBugOutcome(ctx: BugPolicyContext): BugPolicyResult {
  const { mode, outcome, assignment, knownEvidence, riskClass, run } = ctx;
  const policy = modePolicy(mode);
  const notes: string[] = [];

  // Terminal expected-behavior without code is legal only in modes that allow it.
  if (
    outcome.status === "expected_behavior" ||
    (outcome.action === "complete" && outcome.status === "succeeded" &&
      run.phase === "diagnosis" && mode === "expected-behavior")
  ) {
    if (!policy.allowsExpectedBehaviorTerminal) {
      return {
        ok: false,
        reason: `${mode} cannot terminate as expected-behavior`,
        escalate: true,
      };
    }
    // No mutation scope required.
    if (assignment.mutationScope.length > 0) {
      notes.push(
        "expected-behavior completion with non-empty mutationScope; runtime ignores mutations",
      );
    }
    return { ok: true, notes };
  }

  // High-risk / systemic: must escalate rather than auto-fix.
  if (
    riskClass &&
    policy.humanGatedRisks.includes(riskClass) &&
    outcome.action !== "escalate" &&
    (run.phase === "diagnosis" || run.phase === "evidence") &&
    (outcome.action === "handoff" || outcome.action === "complete") &&
    outcome.targetAgent !== "human"
  ) {
    // Allow handoff only to risk-gate / human path.
    if (outcome.nextAssignment?.targetAgent !== "human") {
      return {
        ok: false,
        reason: `risk class ${riskClass} requires human gate in ${mode}`,
        escalate: true,
      };
    }
  }

  // Leaving evidence/diagnosis for fixing requires required evidence.
  if (
    outcome.action === "handoff" &&
    (run.phase === "evidence" || run.phase === "diagnosis") &&
    outcome.nextAssignment?.targetAgent === "build"
  ) {
    const plan = evidencePlanForMode(mode);
    const missing = plan.required.filter((k) => !knownEvidence.includes(k));
    // Allow progress when outcome itself supplies evidence refs named as kinds.
    const supplied = evidenceKindsFromRefs(outcome.evidenceRefs);
    const stillMissing = missing.filter((k) => !supplied.includes(k));
    if (stillMissing.length > 0 && mode !== "expected-behavior") {
      // Focused may proceed with partial if reproduction present; full is stricter.
      if (mode === "full-investigation") {
        return {
          ok: false,
          reason: `full-investigation missing required evidence: ${stillMissing.join(", ")}`,
          escalate: true,
        };
      }
      if (mode === "focused-debug" && stillMissing.includes("reproduction")) {
        return {
          ok: false,
          reason: "focused-debug requires reproduction before fix handoff",
          escalate: false,
        };
      }
      notes.push(
        `proceeding with partial evidence; missing: ${stillMissing.join(", ")}`,
      );
    }
  }

  // Validation gate: review alone is not validation for write-path bugs.
  if (
    policy.requiresBehavioralValidation &&
    run.phase === "validating" &&
    outcome.action === "complete" &&
    outcome.status === "succeeded"
  ) {
    const hasBehavioral = outcome.checks.some(
      (c) =>
        (c.name === "behavioral" ||
          c.name === "reproduction" ||
          c.name === "validation") &&
        c.status === "passed",
    );
    const hasEvidence =
      outcome.evidenceRefs.length > 0 ||
      outcome.checks.some((c) => c.status === "passed");
    if (!hasBehavioral && !hasEvidence) {
      return {
        ok: false,
        reason:
          "write-path validation requires behavioral check or evidence; review alone is insufficient",
        escalate: false,
      };
    }
  }

  // Failed validation → rework must not claim gates still pass.
  if (
    (run.phase === "validating" || run.phase === "reviewing") &&
    outcome.status === "failed" &&
    outcome.action === "handoff"
  ) {
    notes.push("failed validation/review returns to rework; gates invalidate");
  }

  return { ok: true, notes };
}

/**
 * Whether evidence collection for this mode is "proportional" — focused has
 * fewer required kinds than full-investigation.
 */
export function evidenceIsProportional(
  mode: BugMode,
  known: EvidenceKind[],
  skipped: Array<{ kind: EvidenceKind; reason: string }>,
): { ok: boolean; missing: EvidenceKind[]; notes: string[] } {
  const plan = evidencePlanForMode(mode);
  const skipSet = new Set(skipped.map((s) => s.kind));
  const missing = plan.required.filter(
    (k) => !known.includes(k) && !skipSet.has(k),
  );
  const notes: string[] = [];
  for (const s of skipped) {
    if (plan.required.includes(s.kind) && !s.reason.trim()) {
      notes.push(`skip of required ${s.kind} lacks reason`);
    }
  }
  // Full investigation: optional kinds should at least be considered (present or skipped).
  if (mode === "full-investigation") {
    for (const opt of plan.optional) {
      if (!known.includes(opt) && !skipSet.has(opt)) {
        notes.push(`full-investigation has not considered optional ${opt}`);
      }
    }
  }
  return { ok: missing.length === 0, missing, notes };
}

export function evidenceKindsFromRefs(refs: string[]): EvidenceKind[] {
  const kinds: EvidenceKind[] = [];
  const all: EvidenceKind[] = [
    "report",
    "logs",
    "reproduction",
    "code-path",
    "fixture",
    "integration-test",
    "browser",
    "metrics",
    "human-confirmation",
  ];
  for (const ref of refs) {
    const lower = ref.toLowerCase();
    for (const k of all) {
      if (lower.includes(k) && !kinds.includes(k)) kinds.push(k);
    }
  }
  return kinds;
}

/**
 * Aggregate gate check: review, validation, and checks must share one
 * attempt revision digest / subject SHAs.
 */
export function revisionGatesConsistent(gates: PipelineGate[]): {
  ok: boolean;
  reason?: string;
} {
  const active = gates.filter(
    (g) =>
      g.status !== "invalidated" &&
      (g.gateKind === "review" ||
        g.gateKind === "validation" ||
        g.gateKind === "checks"),
  );
  if (active.length === 0) return { ok: true };

  const shas = new Set(
    active.map((g) => g.subjectSha).filter((s): s is string => s != null),
  );
  if (shas.size > 1) {
    return {
      ok: false,
      reason: `review/validation/checks subject SHAs diverge: ${[...shas].join(", ")}`,
    };
  }

  const attempts = new Set(active.map((g) => g.attemptId));
  if (attempts.size > 1) {
    return {
      ok: false,
      reason: "review/validation/checks span multiple attempts",
    };
  }

  return { ok: true };
}
