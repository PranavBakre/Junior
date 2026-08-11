import { describe, expect, it } from "bun:test";
import {
  computeMetrics,
  isEligibleForLighterApproval,
  type DefinitionMetrics,
} from "./metrics.ts";
import type { DefinitionRun } from "./catalog-store.ts";

function makeRun(overrides?: Partial<DefinitionRun>): DefinitionRun {
  return {
    id: "run-" + Math.random().toString(36).slice(2, 8),
    kind: "runbook",
    name: "test-runbook",
    versionDigest: "digest-1",
    ownerAgent: "build",
    intentFingerprint: "fp-1",
    risk: "production-write",
    status: "completed",
    startedAt: Date.now(),
    completedAt: Date.now(),
    approvalRef: null,
    evidenceRefs: null,
    ...overrides,
  };
}

/**
 * Build a clean metrics object suitable for lighter-approval eligibility.
 * Override individual fields to test specific disqualifying conditions.
 */
function makeCleanMetrics(
  overrides?: Partial<DefinitionMetrics>,
): DefinitionMetrics {
  return {
    name: "test-runbook",
    versionDigest: "digest-1",
    selectionCount: 12,
    completionCount: 12,
    failureCount: 0,
    gateComplianceRate: 1,
    verificationSuccessRate: 1,
    humanCorrectionCount: 0,
    rollbackCount: 0,
    lastUsedAt: Date.now(),
    ...overrides,
  };
}

describe("computeMetrics", () => {
  it("returns null for empty runs", () => {
    const result = computeMetrics([]);
    expect(result).toBeNull();
  });

  it("counts all completed runs correctly", () => {
    const runs = Array.from({ length: 5 }, () => makeRun({ status: "completed" }));
    const metrics = computeMetrics(runs)!;

    expect(metrics).not.toBeNull();
    expect(metrics.selectionCount).toBe(5);
    expect(metrics.completionCount).toBe(5);
    expect(metrics.failureCount).toBe(0);
  });

  it("counts mixed statuses correctly", () => {
    const runs = [
      makeRun({ status: "completed" }),
      makeRun({ status: "completed" }),
      makeRun({ status: "completed" }),
      makeRun({ status: "failed" }),
      makeRun({ status: "failed" }),
    ];
    const metrics = computeMetrics(runs)!;

    expect(metrics.selectionCount).toBe(5);
    expect(metrics.completionCount).toBe(3);
    expect(metrics.failureCount).toBe(2);
  });

  it("rejected runs increment humanCorrectionCount", () => {
    const runs = [
      makeRun({ status: "completed" }),
      makeRun({ status: "rejected" }),
      makeRun({ status: "rejected" }),
    ];
    const metrics = computeMetrics(runs)!;

    expect(metrics.humanCorrectionCount).toBe(2);
  });

  it("computes gate compliance rate for runs with approvalRef", () => {
    // 2 runs with approvalRef: one completed, one approved
    // 1 run without approvalRef: completed
    const runs = [
      makeRun({ status: "completed", approvalRef: "approval-1" }),
      makeRun({ status: "approved", approvalRef: "approval-2" }),
      makeRun({ status: "completed", approvalRef: null }),
    ];
    const metrics = computeMetrics(runs)!;

    // approvalRequired = 2 (the two with approvalRef)
    // gateComplianceRate = (approvedCount + completionCount) / selectionCount
    //   = (1 + 1) / 3 = 0.666...
    // But capped at 1.0
    expect(metrics.gateComplianceRate).toBeGreaterThan(0);
    expect(metrics.gateComplianceRate).toBeLessThanOrEqual(1);
  });

  it("verification success rate = completed / (completed + failed)", () => {
    const runs = [
      makeRun({ status: "completed" }),
      makeRun({ status: "completed" }),
      makeRun({ status: "failed" }),
    ];
    const metrics = computeMetrics(runs)!;

    expect(metrics.verificationSuccessRate).toBeCloseTo(2 / 3, 5);
  });

  it("lastUsedAt is the latest timestamp from runs", () => {
    const runs = [
      makeRun({ startedAt: 1000, completedAt: 1500 }),
      makeRun({ startedAt: 3000, completedAt: 3500 }),
      makeRun({ startedAt: 2000, completedAt: 2500 }),
    ];
    const metrics = computeMetrics(runs)!;

    expect(metrics.lastUsedAt).toBe(3500);
  });
});

describe("isEligibleForLighterApproval", () => {
  it("read-only, 10+ clean runs, 0 rollbacks/corrections: eligible", () => {
    const metrics = makeCleanMetrics();
    expect(isEligibleForLighterApproval(metrics, "read-only")).toBe(true);
  });

  it("workspace-write, 10+ clean runs, 0 problems: eligible", () => {
    const metrics = makeCleanMetrics();
    expect(isEligibleForLighterApproval(metrics, "workspace-write")).toBe(true);
  });

  it("production-write (high-risk): always ineligible", () => {
    const metrics = makeCleanMetrics();
    expect(isEligibleForLighterApproval(metrics, "production-write")).toBe(
      false,
    );
  });

  it("destructive (high-risk): always ineligible", () => {
    const metrics = makeCleanMetrics();
    expect(isEligibleForLighterApproval(metrics, "destructive")).toBe(false);
  });

  it("credential (high-risk): always ineligible", () => {
    const metrics = makeCleanMetrics();
    expect(isEligibleForLighterApproval(metrics, "credential")).toBe(false);
  });

  it("payment (high-risk): always ineligible", () => {
    const metrics = makeCleanMetrics();
    expect(isEligibleForLighterApproval(metrics, "payment")).toBe(false);
  });

  it("privacy-sensitive (high-risk): always ineligible", () => {
    const metrics = makeCleanMetrics();
    expect(isEligibleForLighterApproval(metrics, "privacy-sensitive")).toBe(
      false,
    );
  });

  it("access-control (high-risk): always ineligible", () => {
    const metrics = makeCleanMetrics();
    expect(isEligibleForLighterApproval(metrics, "access-control")).toBe(false);
  });

  it("fewer than 10 completed runs: ineligible", () => {
    const metrics = makeCleanMetrics({ completionCount: 9 });
    expect(isEligibleForLighterApproval(metrics, "read-only")).toBe(false);
  });

  it("has rollbacks: ineligible", () => {
    const metrics = makeCleanMetrics({ rollbackCount: 1 });
    expect(isEligibleForLighterApproval(metrics, "read-only")).toBe(false);
  });

  it("has human corrections: ineligible", () => {
    const metrics = makeCleanMetrics({ humanCorrectionCount: 1 });
    expect(isEligibleForLighterApproval(metrics, "read-only")).toBe(false);
  });

  it("gate compliance < 100%: ineligible", () => {
    const metrics = makeCleanMetrics({ gateComplianceRate: 0.9 });
    expect(isEligibleForLighterApproval(metrics, "read-only")).toBe(false);
  });

  it("verification success rate < 100%: ineligible", () => {
    const metrics = makeCleanMetrics({ verificationSuccessRate: 0.95 });
    expect(isEligibleForLighterApproval(metrics, "workspace-write")).toBe(
      false,
    );
  });
});
