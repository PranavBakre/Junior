/**
 * Product pipeline definition — phases, ownership, skip rules, phase intent.
 * Transition legality remains in src/pipelines/transitions.ts; this module
 * owns stage contract and phase suggestion for ProductRun controllers.
 */

import type { ProductPhase, TerminalOutcome } from "../types.ts";
import {
  isProductPhase,
  isTerminalPhase,
  productTransitions,
} from "../transitions.ts";

export const PRODUCT_PHASES: readonly ProductPhase[] = [
  "discovery",
  "spec-drafting",
  "awaiting-product-decision",
  "ready-to-build",
  "building",
  "aggregate-verification",
  "pr-open",
  "reviewing",
  "fixing",
  "approved",
  "ready-for-human-merge",
  "shipped",
  "needs-human",
  "abandoned",
] as const;

/** Ownership roles for product delivery. */
export type ProductRole =
  | "pm"
  | "architect"
  | "build"
  | "frontend"
  | "orchestrator"
  | "review"
  | "human";

export type ProductOwnership = {
  role: ProductRole;
  owns: string[];
};

export const PRODUCT_OWNERSHIP: readonly ProductOwnership[] = [
  {
    role: "pm",
    owns: [
      "problem",
      "scope",
      "user-flow",
      "acceptance-criteria",
      "cut-list",
    ],
  },
  {
    role: "architect",
    owns: [
      "contracts",
      "state-data-design",
      "risk-analysis",
      "technical-verification-plan",
    ],
  },
  {
    role: "build",
    owns: ["backend-code", "focused-checks", "checkpoint-commits"],
  },
  {
    role: "frontend",
    owns: ["frontend-code", "focused-checks", "checkpoint-commits"],
  },
  {
    role: "orchestrator",
    owns: [
      "aggregate-verification",
      "push-pr-coordination",
      "phase-transitions",
    ],
  },
  {
    role: "review",
    owns: ["read-only-findings", "typed-verdict"],
  },
  {
    role: "human",
    owns: [
      "material-product-decisions",
      "gated-external-destructive-actions",
      "final-protected-branch-merge",
    ],
  },
] as const;

/** Why PM and/or architecture stages were skipped. */
export type SkipStageReason = {
  stage: "pm" | "architecture";
  reason: string;
};

/**
 * Direct implementation starts (build/fix/implement) authorize scoped work
 * without a redundant go-word when the request is well-specified enough that
 * PM/architecture output cannot change implementation.
 */
export function shouldSkipPmAndArchitecture(input: {
  startKind: "pm" | "build";
  objective: string;
  /** Explicit operator override to force discovery/PM path. */
  forceDiscovery?: boolean;
}): { skip: boolean; reasons: SkipStageReason[] } {
  if (input.startKind === "pm" || input.forceDiscovery) {
    return { skip: false, reasons: [] };
  }

  const objective = input.objective.trim();
  // Empty or tiny prompts still need discovery.
  if (objective.length < 12) {
    return { skip: false, reasons: [] };
  }

  // Ambiguous product questions should not skip.
  if (
    /\b(should we|what if|which approach|trade-?off|priorit[yz]|scope\?|mvp\?)\b/i.test(
      objective,
    )
  ) {
    return { skip: false, reasons: [] };
  }

  // Direct implementation language + concrete object → skip both stages.
  const directImpl =
    /\b(build|fix|implement|add|create|wire|ship)\b/i.test(objective);
  const hasConcreteTarget =
    /\b(endpoint|api|route|handler|component|page|ui|button|form|table|schema|migration|service|hook|modal|screen)\b/i.test(
      objective,
    ) || objective.length >= 40;

  if (directImpl && hasConcreteTarget) {
    return {
      skip: true,
      reasons: [
        {
          stage: "pm",
          reason:
            "direct build/fix/implement request is well-specified; PM output cannot change implementation scope",
        },
        {
          stage: "architecture",
          reason:
            "scoped implementation request; architecture contracts already implied or unchanged",
        },
      ],
    };
  }

  // Explicit "skip planning" / well-known go-word already given for scoped work.
  if (
    /\b(just (build|implement|fix)|no planning|skip (pm|planning|architecture)|already scoped)\b/i.test(
      objective,
    )
  ) {
    return {
      skip: true,
      reasons: [
        {
          stage: "pm",
          reason: "operator authorized direct implementation without planning",
        },
        {
          stage: "architecture",
          reason: "operator authorized direct implementation without planning",
        },
      ],
    };
  }

  return { skip: false, reasons: [] };
}

/** Initial phase + target agent for an explicit product start. */
export function initialProductStart(input: {
  startKind: "pm" | "build";
  objective: string;
  forceDiscovery?: boolean;
}): {
  phase: ProductPhase;
  targetAgent: string;
  ownerAgent: string;
  skipReasons: SkipStageReason[];
} {
  if (input.startKind === "pm") {
    return {
      phase: "discovery",
      targetAgent: "pm",
      ownerAgent: "default",
      skipReasons: [],
    };
  }

  const { skip, reasons } = shouldSkipPmAndArchitecture(input);
  if (skip) {
    return {
      phase: "ready-to-build",
      targetAgent: "build",
      ownerAgent: "default",
      skipReasons: reasons,
    };
  }

  // !build without enough specificity still starts at discovery via orchestrator
  // so PM/architecture can be dispatched; no redundant go-word once scoped.
  return {
    phase: "discovery",
    targetAgent: "default",
    ownerAgent: "default",
    skipReasons: [],
  };
}

/** Legal next phases for a product phase (delegates to transitions table). */
export function legalNextPhases(from: ProductPhase): readonly ProductPhase[] {
  return productTransitions()[from];
}

export function canProductTransition(from: string, to: string): boolean {
  if (!isProductPhase(from) || !isProductPhase(to)) return false;
  if (from === to) return true;
  return productTransitions()[from].includes(to);
}

export function isProductTerminalPhase(phase: string): boolean {
  return isTerminalPhase("product", phase);
}

export function terminalOutcomeForPhase(
  phase: string,
): Exclude<TerminalOutcome, null> | null {
  if (phase === "shipped") return "shipped";
  if (phase === "abandoned") return "abandoned";
  return null;
}

/**
 * Phases bound to an attempt revision vector. Changing any member creates a
 * new digest and reopens aggregate gates.
 */
export const REVISION_BOUND_PHASES: ReadonlySet<ProductPhase> = new Set([
  "aggregate-verification",
  "pr-open",
  "reviewing",
  "approved",
  "ready-for-human-merge",
]);

/**
 * Suggest the next controller phase after an agent outcome status.
 * Pure heuristic — runtime still validates via canTransition + policy.
 */
export function suggestPhaseAfterOutcome(input: {
  currentPhase: ProductPhase;
  outcomeStatus:
    | "progress"
    | "succeeded"
    | "expected_behavior"
    | "not_reproduced"
    | "blocked"
    | "failed";
  outcomeAction?:
    | "continue_self"
    | "handoff"
    | "wait"
    | "escalate"
    | "complete";
  /** Review verdict when current phase is reviewing. */
  reviewVerdict?: "approved" | "changes_requested" | "comment" | null;
  /** True when all fan-out builder assignments have completed. */
  allBuildersDone?: boolean;
  /** True when every required PR association is registered for the attempt. */
  allPrsRegistered?: boolean;
  /** True when a material product decision is still open. */
  needsProductDecision?: boolean;
}): ProductPhase | null {
  const {
    currentPhase,
    outcomeStatus,
    outcomeAction,
    reviewVerdict,
    allBuildersDone = true,
    allPrsRegistered = true,
    needsProductDecision = false,
  } = input;

  if (outcomeStatus === "blocked" || outcomeAction === "escalate") {
    return "needs-human";
  }

  if (outcomeStatus === "failed") {
    if (
      currentPhase === "reviewing" ||
      currentPhase === "aggregate-verification" ||
      currentPhase === "approved"
    ) {
      return "fixing";
    }
    if (currentPhase === "building") return "building";
    return null;
  }

  if (outcomeStatus !== "succeeded" && outcomeStatus !== "progress") {
    return null;
  }

  switch (currentPhase) {
    case "discovery":
      if (needsProductDecision) return "awaiting-product-decision";
      return "spec-drafting";
    case "spec-drafting":
      if (needsProductDecision) return "awaiting-product-decision";
      return "ready-to-build";
    case "awaiting-product-decision":
      return "ready-to-build";
    case "ready-to-build":
      return "building";
    case "building":
      // Fan-out: stay in building until every required builder finishes.
      if (!allBuildersDone) return "building";
      return "aggregate-verification";
    case "aggregate-verification":
      return "pr-open";
    case "pr-open":
      return allPrsRegistered ? "reviewing" : "pr-open";
    case "reviewing":
      if (reviewVerdict === "changes_requested") {
        return "fixing";
      }
      if (reviewVerdict === "approved" || outcomeStatus === "succeeded") {
        return "approved";
      }
      return null;
    case "fixing":
      // After fix, re-enter building (or aggregate-verification when single stream).
      return "building";
    case "approved":
      return "ready-for-human-merge";
    case "ready-for-human-merge":
      // Human merge only — agents cannot auto-ship.
      return null;
    default:
      return null;
  }
}

/**
 * Detect full-stack intent so the controller can fan out build + frontend.
 */
export function detectFullStackIntent(objective: string): boolean {
  const text = objective.toLowerCase();
  if (/\bfull[- ]?stack\b/.test(text)) return true;
  const hasBackend =
    /\b(backend|api|endpoint|service|schema|migration|handler)\b/.test(text);
  const hasFrontend =
    /\b(frontend|ui|page|component|react|screen|modal|form)\b/.test(text);
  return hasBackend && hasFrontend;
}

/** Builder agents that may participate in product fan-out. */
export const PRODUCT_BUILDER_AGENTS = ["build", "frontend"] as const;

export function isProductBuilderAgent(name: string): boolean {
  return (PRODUCT_BUILDER_AGENTS as readonly string[]).includes(name);
}
