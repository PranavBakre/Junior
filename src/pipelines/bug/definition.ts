/**
 * Bug pipeline definition — phases, adaptive modes, and mode→evidence policy.
 * Transition legality remains in src/pipelines/transitions.ts; this module
 * owns mode selection and phase intent for BugRun controllers.
 */

import type { BugMode, BugPhase, TerminalOutcome } from "../types.ts";
import { bugTransitions, isBugPhase, isTerminalPhase } from "../transitions.ts";

export type { BugMode };

export const BUG_MODES: readonly BugMode[] = [
  "expected-behavior",
  "focused-debug",
  "full-investigation",
] as const;

export type EvidenceKind =
  | "report"
  | "logs"
  | "reproduction"
  | "code-path"
  | "fixture"
  | "integration-test"
  | "browser"
  | "metrics"
  | "human-confirmation";

export type RiskClass =
  | "low"
  | "medium"
  | "high"
  | "auth"
  | "payments"
  | "privacy"
  | "data-repair"
  | "production"
  | "destructive";

export type BugModePolicy = {
  mode: BugMode;
  /** Evidence kinds the mode prefers to collect before diagnosis. */
  requiredEvidence: EvidenceKind[];
  /** Evidence that may be skipped with an explicit reason recorded. */
  optionalEvidence: EvidenceKind[];
  /** Mutations permitted without an extra human gate (still scoped). */
  permittedMutations: string[];
  /** Risk classes that force a named human gate inside this mode. */
  humanGatedRisks: RiskClass[];
  /** Default deadline budget for an investigation turn set (ms). */
  defaultDeadlineMs: number;
  /** Whether the mode may terminate as expected-behavior without code. */
  allowsExpectedBehaviorTerminal: boolean;
  /** Whether write-path validation (behavioral gate) is required. */
  requiresBehavioralValidation: boolean;
};

const MODE_POLICIES: Record<BugMode, BugModePolicy> = {
  "expected-behavior": {
    mode: "expected-behavior",
    requiredEvidence: ["report"],
    optionalEvidence: ["logs", "reproduction", "code-path"],
    permittedMutations: [],
    humanGatedRisks: [
      "auth",
      "payments",
      "privacy",
      "data-repair",
      "production",
      "destructive",
    ],
    defaultDeadlineMs: 30 * 60_000,
    allowsExpectedBehaviorTerminal: true,
    requiresBehavioralValidation: false,
  },
  "focused-debug": {
    mode: "focused-debug",
    requiredEvidence: ["report", "reproduction", "code-path"],
    optionalEvidence: ["logs", "fixture", "browser"],
    permittedMutations: ["worktree-code", "fixture-data"],
    humanGatedRisks: [
      "auth",
      "payments",
      "privacy",
      "data-repair",
      "production",
      "destructive",
    ],
    defaultDeadlineMs: 4 * 60 * 60_000,
    allowsExpectedBehaviorTerminal: true,
    requiresBehavioralValidation: true,
  },
  "full-investigation": {
    mode: "full-investigation",
    requiredEvidence: [
      "report",
      "logs",
      "reproduction",
      "code-path",
      "metrics",
    ],
    optionalEvidence: ["fixture", "integration-test", "browser"],
    permittedMutations: ["worktree-code", "fixture-data", "test-tenant"],
    humanGatedRisks: [
      "high",
      "auth",
      "payments",
      "privacy",
      "data-repair",
      "production",
      "destructive",
    ],
    defaultDeadlineMs: 24 * 60 * 60_000,
    allowsExpectedBehaviorTerminal: true,
    requiresBehavioralValidation: true,
  },
};

export function isBugMode(value: string): value is BugMode {
  return (BUG_MODES as readonly string[]).includes(value);
}

export function modePolicy(mode: BugMode): BugModePolicy {
  return MODE_POLICIES[mode];
}

/**
 * Choose an adaptive mode from an explicit start or classified signal.
 * MVP: explicit starts default to focused-debug; callers may override.
 */
export function selectBugMode(input: {
  explicitMode?: BugMode | string | null;
  /** Free-text hint from !debug / human classification. */
  hint?: string | null;
  /** When true, prefer full investigation (systemic / multi-service). */
  systemic?: boolean;
  /** When true, prefer expected-behavior (docs / "by design" report). */
  likelyExpected?: boolean;
}): BugMode {
  if (input.explicitMode && isBugMode(input.explicitMode)) {
    return input.explicitMode;
  }
  if (input.likelyExpected) return "expected-behavior";
  if (input.systemic) return "full-investigation";

  const hint = (input.hint ?? "").toLowerCase();
  if (
    /\b(expected|by design|working as intended|not a bug|wai)\b/.test(hint)
  ) {
    return "expected-behavior";
  }
  if (
    /\b(systemic|widespread|multi[- ]?repo|incident|sev[0-2]|outage)\b/.test(
      hint,
    )
  ) {
    return "full-investigation";
  }
  return "focused-debug";
}

/** Legal next phases for a bug phase (delegates to transitions table). */
export function legalNextPhases(from: BugPhase): readonly BugPhase[] {
  return bugTransitions()[from];
}

export function canBugTransition(from: string, to: string): boolean {
  if (!isBugPhase(from) || !isBugPhase(to)) return false;
  if (from === to) return true;
  return bugTransitions()[from].includes(to);
}

export function isBugTerminalPhase(phase: string): boolean {
  return isTerminalPhase("bug", phase);
}

/** Map a terminal phase to TerminalOutcome. */
export function terminalOutcomeForPhase(
  phase: string,
): Exclude<TerminalOutcome, null> | null {
  if (phase === "expected-behavior") return "expected-behavior";
  if (phase === "not-reproduced") return "not-reproduced";
  if (phase === "abandoned") return "abandoned";
  if (phase === "merged" || phase === "cleanup") return "merged";
  return null;
}

/**
 * Phases that fan out review + validation + checks against one attempt
 * revision vector. Changing any member invalidates all aggregate gates.
 */
export const REVISION_BOUND_PHASES: ReadonlySet<BugPhase> = new Set([
  "reviewing",
  "validating",
  "checks",
]);

/**
 * Evidence proportional to mode: focused collects the minimum path;
 * full requires broader evidence before diagnosis→fix.
 */
export function evidencePlanForMode(mode: BugMode): {
  required: EvidenceKind[];
  optional: EvidenceKind[];
  skipAllowed: EvidenceKind[];
} {
  const policy = modePolicy(mode);
  return {
    required: [...policy.requiredEvidence],
    optional: [...policy.optionalEvidence],
    // Anything not required may be skipped with a reason.
    skipAllowed: [...policy.optionalEvidence],
  };
}

/**
 * Suggest the next controller phase after an agent outcome status, given mode.
 * Pure heuristic — runtime still validates via canTransition + policy.
 */
export function suggestPhaseAfterOutcome(input: {
  mode: BugMode;
  currentPhase: BugPhase;
  outcomeStatus:
    | "progress"
    | "succeeded"
    | "expected_behavior"
    | "not_reproduced"
    | "blocked"
    | "failed";
  riskClass?: RiskClass;
}): BugPhase | null {
  const { mode, currentPhase, outcomeStatus, riskClass } = input;
  const policy = modePolicy(mode);

  if (outcomeStatus === "expected_behavior") {
    return policy.allowsExpectedBehaviorTerminal
      ? "expected-behavior"
      : "needs-human";
  }
  if (outcomeStatus === "not_reproduced") return "not-reproduced";
  if (outcomeStatus === "blocked") return "needs-human";

  if (
    riskClass &&
    policy.humanGatedRisks.includes(riskClass) &&
    (currentPhase === "diagnosis" || currentPhase === "evidence")
  ) {
    return "risk-gate";
  }

  if (outcomeStatus === "failed") {
    if (currentPhase === "validating" || currentPhase === "reviewing") {
      return "fixing";
    }
    if (currentPhase === "checks") return "fixing";
    return null;
  }

  if (outcomeStatus !== "succeeded" && outcomeStatus !== "progress") {
    return null;
  }

  switch (currentPhase) {
    case "intake":
      return mode === "expected-behavior" ? "evidence" : "evidence";
    case "evidence":
      return mode === "expected-behavior" ? "diagnosis" : "diagnosis";
    case "diagnosis":
      if (mode === "expected-behavior") return "expected-behavior";
      return "fixing";
    case "risk-gate":
      return "fixing";
    case "fixing":
      return "reviewing";
    case "reviewing":
      return policy.requiresBehavioralValidation ? "validating" : "checks";
    case "validating":
      return "checks";
    case "checks":
      return "dev-merge";
    case "dev-merge":
      return "main-merge-gate";
    case "main-merge-gate":
      return "merged";
    case "merged":
      return "cleanup";
    default:
      return null;
  }
}
