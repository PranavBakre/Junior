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
  assignmentCount: number;
  openAssignmentCount: number;
  lastOutcomeSummary: string | null;
  humanReadable: string;
};

/**
 * Read-only human projection for dashboard / !status.
 * Does not mutate store state.
 */
export function projectRunSummary(
  run: PipelineRun,
  assignments: Assignment[],
  latestOutcome: StoredOutcome | null,
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

  const humanReadable = [
    `${run.kind} run ${run.id.slice(0, 8)}`,
    `phase=${run.phase}`,
    `status=${run.status}`,
    `owner=${run.ownerAgent}`,
    `v${run.stateVersion}`,
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
    assignmentCount: assignments.length,
    openAssignmentCount,
    lastOutcomeSummary,
    humanReadable,
  };
}
