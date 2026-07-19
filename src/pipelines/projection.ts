import type { Assignment, PipelineRun, StoredOutcome } from "./types.ts";
import { isTerminalPhase } from "./transitions.ts";

export type RunSummary = {
  runId: string;
  kind: PipelineRun["kind"];
  phase: string;
  status: PipelineRun["status"];
  ownerAgent: string;
  stateVersion: number;
  terminalOutcome: PipelineRun["terminalOutcome"];
  activeAttemptId: string | null;
  /** Short attempt revision digest (first 12 hex chars) when known. */
  attemptDigest: string | null;
  assignmentCount: number;
  openAssignmentCount: number;
  lastOutcomeSummary: string | null;
  humanReadable: string;
};

export type ProjectRunSummaryOptions = {
  /**
   * Full or short revision digest for the active attempt. When a full hex
   * digest is provided, the summary shortens it for display.
   */
  attemptDigest?: string | null;
};

/**
 * Read-only human projection for dashboard / !status.
 * Does not mutate store state.
 */
export function projectRunSummary(
  run: PipelineRun,
  assignments: Assignment[],
  latestOutcome: StoredOutcome | null,
  options: ProjectRunSummaryOptions = {},
): RunSummary {
  const openAssignmentCount = assignments.filter(
    (a) =>
      a.status === "pending" ||
      a.status === "leased" ||
      a.status === "waiting",
  ).length;

  const lastOutcomeSummary = latestOutcome
    ? `${latestOutcome.action}/${latestOutcome.status}: ${latestOutcome.reason}`
    : null;

  const terminal =
    run.status === "terminal" || isTerminalPhase(run.kind, run.phase);

  const rawDigest =
    options.attemptDigest ??
    assignments.find((a) => a.candidateRevisionDigest)?.candidateRevisionDigest ??
    null;
  const attemptDigest = shortDigest(rawDigest);

  const humanReadable = [
    `${run.kind} run ${run.id.slice(0, 8)}`,
    `phase=${run.phase}`,
    `status=${run.status}`,
    `owner=${run.ownerAgent}`,
    `v${run.stateVersion}`,
    attemptDigest ? `attempt=${attemptDigest}` : null,
    openAssignmentCount > 0 ? `${openAssignmentCount} open assignment(s)` : null,
    terminal && run.terminalOutcome
      ? `terminal=${run.terminalOutcome}`
      : null,
    lastOutcomeSummary ? `last: ${lastOutcomeSummary}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    runId: run.id,
    kind: run.kind,
    phase: run.phase,
    status: run.status,
    ownerAgent: run.ownerAgent,
    stateVersion: run.stateVersion,
    terminalOutcome: run.terminalOutcome,
    activeAttemptId: run.activeAttemptId,
    attemptDigest,
    assignmentCount: assignments.length,
    openAssignmentCount,
    lastOutcomeSummary,
    humanReadable,
  };
}

function shortDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const trimmed = digest.trim();
  if (!trimmed) return null;
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

/**
 * Format a multi-line Slack !status block for an active pipeline run.
 */
export function formatPipelineStatusLines(summary: RunSummary): string[] {
  return [
    `*Pipeline:* ${summary.kind} \`${summary.runId}\``,
    `*Pipeline phase:* ${summary.phase} (${summary.status})`,
    `*Pipeline owner:* ${summary.ownerAgent}`,
    summary.attemptDigest
      ? `*Attempt digest:* \`${summary.attemptDigest}\``
      : null,
    summary.openAssignmentCount > 0
      ? `*Open assignments:* ${summary.openAssignmentCount}/${summary.assignmentCount}`
      : `*Assignments:* ${summary.assignmentCount}`,
    summary.lastOutcomeSummary
      ? `*Last outcome:* ${summary.lastOutcomeSummary}`
      : null,
  ].filter((line): line is string => line != null);
}
