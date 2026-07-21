/**
 * Build bounded assignment context blocks for injection into agent prompts.
 * Runtime state is authoritative; prompts must not invent phase or ownership.
 */

import type { Assignment, PipelineRun } from "./types.ts";
import { projectRunSummary } from "./projection.ts";

export type AssignmentContextInput = {
  run: PipelineRun;
  assignment: Assignment;
  /** Optional extra lines (e.g. revision members, gate status). */
  extras?: string[];
};

/**
 * Mandatory assignment context injected when a pipeline assignment is
 * dispatched. Workers must not infer phase from file existence or thread
 * position — this block is the source of truth for the turn.
 */
export function buildAssignmentContext(input: AssignmentContextInput): string {
  const { run, assignment, extras = [] } = input;
  const summary = projectRunSummary(run, [assignment], null);

  const lines = [
    "<pipeline-assignment>",
    `run_id: ${run.id}`,
    `kind: ${run.kind}`,
    `phase: ${run.phase}`,
    `run_status: ${run.status}`,
    `state_version: ${run.stateVersion}`,
    `owner_agent: ${run.ownerAgent}`,
    `assignment_id: ${assignment.id}`,
    `source_agent: ${assignment.sourceAgent}`,
    `target_agent: ${assignment.targetAgent}`,
    `attempt: ${assignment.attempt}`,
    `attempt_id: ${assignment.attemptId ?? ""}`,
    `candidate_revision_digest: ${assignment.candidateRevisionDigest ?? ""}`,
    `parent_assignment_id: ${assignment.parentAssignmentId ?? ""}`,
    `objective: ${assignment.objective}`,
    `acceptance_criteria: ${JSON.stringify(assignment.acceptanceCriteria)}`,
    `mutation_scope: ${JSON.stringify(assignment.mutationScope)}`,
    `context_refs: ${JSON.stringify(assignment.contextRefs)}`,
    `artifact_refs: ${JSON.stringify(assignment.artifactRefs)}`,
    `depends_on: ${JSON.stringify(assignment.dependsOn)}`,
    `deadline_at: ${assignment.deadlineAt ?? run.deadlineAt ?? ""}`,
    `repo_refs: ${JSON.stringify(run.repoRefs)}`,
    `run_summary: ${summary.humanReadable}`,
    "control_plane: exactly one accepted decision is required before this invocation ends",
    "dispatch: agent_dispatch(mode=delegate|handoff) is the only agent-to-agent execution path",
    "delegate_semantics: child completion durably resumes this assignment",
    "handoff_semantics: this assignment completes and the successor owns continuation",
    "wait_semantics: only registered external wake sources; never wait for another agent",
    "retry_semantics: reuse the same idempotency key; refresh state once on CAS conflict",
    ...extras,
    "</pipeline-assignment>",
  ];

  return lines.join("\n");
}

/**
 * Compose a dispatch prompt: assignment context + caller objective text.
 */
export function composeDispatchPrompt(
  contextBlock: string,
  objective: string,
): string {
  const body = objective.trim();
  if (!body) return contextBlock;
  return `${contextBlock}\n\n${body}`;
}
