import { HIGH_RISK_KINDS, type RunbookRisk } from "./types.ts";
import type { DefinitionRun } from "./catalog-store.ts";

export interface DefinitionMetrics {
  name: string;
  versionDigest: string;
  selectionCount: number;
  completionCount: number;
  failureCount: number;
  gateComplianceRate: number;
  verificationSuccessRate: number;
  humanCorrectionCount: number;
  rollbackCount: number;
  lastUsedAt: number;
}

export function computeMetrics(
  runs: DefinitionRun[],
): DefinitionMetrics | null {
  if (runs.length === 0) return null;

  const first = runs[0];
  let selectionCount = 0;
  let completionCount = 0;
  let failureCount = 0;
  let rejectedCount = 0;
  let approvedCount = 0;
  let approvalRequired = 0;
  let verifiedCount = 0;
  let lastUsedAt = 0;

  for (const run of runs) {
    selectionCount++;
    if (run.startedAt > lastUsedAt) lastUsedAt = run.startedAt;
    if (run.completedAt && run.completedAt > lastUsedAt) lastUsedAt = run.completedAt;

    switch (run.status) {
      case "completed":
        completionCount++;
        verifiedCount++;
        break;
      case "failed":
        failureCount++;
        break;
      case "rejected":
        rejectedCount++;
        break;
      case "approved":
        approvedCount++;
        break;
    }

    if (run.approvalRef) approvalRequired++;
  }

  const totalCompleteOrFailed = completionCount + failureCount;
  const gateComplianceRate =
    approvalRequired > 0
      ? (approvedCount + completionCount) / selectionCount
      : 1;
  const verificationSuccessRate =
    totalCompleteOrFailed > 0
      ? completionCount / totalCompleteOrFailed
      : 0;

  return {
    name: first.name,
    versionDigest: first.versionDigest,
    selectionCount,
    completionCount,
    failureCount,
    gateComplianceRate: Math.min(gateComplianceRate, 1),
    verificationSuccessRate,
    humanCorrectionCount: rejectedCount,
    rollbackCount: 0,
    lastUsedAt,
  };
}

const LIGHTER_APPROVAL_MIN_RUNS = 10;

export function isEligibleForLighterApproval(
  metrics: DefinitionMetrics,
  risk: RunbookRisk,
): boolean {
  if (HIGH_RISK_KINDS.includes(risk)) return false;

  if (metrics.completionCount < LIGHTER_APPROVAL_MIN_RUNS) return false;
  if (metrics.rollbackCount > 0) return false;
  if (metrics.humanCorrectionCount > 0) return false;
  if (metrics.gateComplianceRate < 1) return false;
  if (metrics.verificationSuccessRate < 1) return false;

  return true;
}
