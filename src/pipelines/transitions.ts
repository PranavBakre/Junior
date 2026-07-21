import type {
  BugPhase,
  DefaultPhase,
  PipelineKind,
  ProductPhase,
} from "./types.ts";

const DEFAULT_TRANSITIONS: Record<DefaultPhase, readonly DefaultPhase[]> = {
  working: ["needs-human", "completed", "abandoned"],
  "needs-human": ["working", "completed", "abandoned"],
  completed: [],
  abandoned: [],
};

/**
 * Legal product-phase edges. Terminal phases have empty outbound sets.
 * `needs-human` can resume into active work phases after human input.
 */
const PRODUCT_TRANSITIONS: Record<ProductPhase, readonly ProductPhase[]> = {
  discovery: [
    "spec-drafting",
    "ready-to-build",
    "awaiting-product-decision",
    "needs-human",
    "abandoned",
  ],
  "spec-drafting": [
    "awaiting-product-decision",
    "ready-to-build",
    "discovery",
    "needs-human",
    "abandoned",
  ],
  "awaiting-product-decision": [
    "ready-to-build",
    "spec-drafting",
    "needs-human",
    "abandoned",
  ],
  "ready-to-build": ["building", "needs-human", "abandoned"],
  building: [
    "aggregate-verification",
    "pr-open",
    "needs-human",
    "abandoned",
  ],
  "aggregate-verification": [
    "pr-open",
    "building",
    "fixing",
    "needs-human",
    "abandoned",
  ],
  "pr-open": ["reviewing", "needs-human", "abandoned"],
  reviewing: ["fixing", "approved", "needs-human", "abandoned"],
  fixing: [
    "building",
    "aggregate-verification",
    "reviewing",
    "needs-human",
    "abandoned",
  ],
  approved: ["fixing", "ready-for-human-merge", "needs-human", "abandoned"],
  "ready-for-human-merge": [
    "fixing",
    "shipped",
    "needs-human",
    "abandoned",
  ],
  shipped: [],
  abandoned: [],
  "needs-human": [
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
    "abandoned",
  ],
};

/**
 * Legal bug-phase edges. Terminal: expected-behavior, not-reproduced, abandoned.
 * `cleanup` is terminal bookkeeping after merge.
 */
const BUG_TRANSITIONS: Record<BugPhase, readonly BugPhase[]> = {
  intake: [
    "evidence",
    "diagnosis",
    "expected-behavior",
    "needs-human",
    "abandoned",
  ],
  evidence: [
    "diagnosis",
    "risk-gate",
    "fixing",
    "expected-behavior",
    "not-reproduced",
    "needs-human",
    "abandoned",
  ],
  diagnosis: [
    "risk-gate",
    "fixing",
    "expected-behavior",
    "not-reproduced",
    "needs-human",
    "abandoned",
  ],
  "risk-gate": ["fixing", "needs-human", "abandoned"],
  fixing: ["reviewing", "validating", "needs-human", "abandoned"],
  reviewing: [
    "fixing",
    "validating",
    "checks",
    "needs-human",
    "abandoned",
  ],
  validating: [
    "fixing",
    "reviewing",
    "checks",
    "needs-human",
    "abandoned",
  ],
  checks: ["fixing", "dev-merge", "needs-human", "abandoned"],
  "dev-merge": ["main-merge-gate", "needs-human", "abandoned"],
  "main-merge-gate": ["merged", "needs-human", "abandoned"],
  merged: ["cleanup"],
  cleanup: [],
  "expected-behavior": [],
  "not-reproduced": [],
  abandoned: [],
  "needs-human": [
    "intake",
    "evidence",
    "diagnosis",
    "risk-gate",
    "fixing",
    "reviewing",
    "validating",
    "checks",
    "dev-merge",
    "main-merge-gate",
    "abandoned",
  ],
};

const PRODUCT_TERMINAL: ReadonlySet<ProductPhase> = new Set([
  "shipped",
  "abandoned",
]);

const BUG_TERMINAL: ReadonlySet<BugPhase> = new Set([
  "cleanup",
  "expected-behavior",
  "not-reproduced",
  "abandoned",
]);

const DEFAULT_TERMINAL: ReadonlySet<DefaultPhase> = new Set([
  "completed",
  "abandoned",
]);

export function isDefaultPhase(value: string): value is DefaultPhase {
  return Object.prototype.hasOwnProperty.call(DEFAULT_TRANSITIONS, value);
}

export function isProductPhase(value: string): value is ProductPhase {
  return Object.prototype.hasOwnProperty.call(PRODUCT_TRANSITIONS, value);
}

export function isBugPhase(value: string): value is BugPhase {
  return Object.prototype.hasOwnProperty.call(BUG_TRANSITIONS, value);
}

export function isTerminalPhase(kind: PipelineKind, phase: string): boolean {
  if (kind === "default") {
    return isDefaultPhase(phase) && DEFAULT_TERMINAL.has(phase);
  }
  if (kind === "product") {
    return isProductPhase(phase) && PRODUCT_TERMINAL.has(phase);
  }
  return isBugPhase(phase) && BUG_TERMINAL.has(phase);
}

export function canTransition(
  kind: PipelineKind,
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  if (kind === "default") {
    if (!isDefaultPhase(from) || !isDefaultPhase(to)) return false;
    return DEFAULT_TRANSITIONS[from].includes(to);
  }
  if (kind === "product") {
    if (!isProductPhase(from) || !isProductPhase(to)) return false;
    return PRODUCT_TRANSITIONS[from].includes(to);
  }
  if (!isBugPhase(from) || !isBugPhase(to)) return false;
  return BUG_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  kind: PipelineKind,
  from: string,
  to: string,
): void {
  if (!canTransition(kind, from, to)) {
    throw new Error(
      `Illegal ${kind} phase transition: ${from} → ${to}`,
    );
  }
}

export function productTransitions(): Readonly<
  Record<ProductPhase, readonly ProductPhase[]>
> {
  return PRODUCT_TRANSITIONS;
}

export function bugTransitions(): Readonly<
  Record<BugPhase, readonly BugPhase[]>
> {
  return BUG_TRANSITIONS;
}
