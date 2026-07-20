/**
 * Mandatory <bug-context> injection for bug pipeline assignments.
 * Workers must not infer phase from file existence or thread position.
 */

import type {
  Assignment,
  AttemptRevisionMember,
  BugRun,
  PipelineGate,
} from "../types.ts";
import type { BugMode, RiskClass } from "./definition.ts";
import { modePolicy } from "./definition.ts";

export type BugContextInput = {
  run: BugRun;
  assignment: Assignment;
  mode: BugMode;
  /** Absolute artifact directory for this bug run. */
  artifactDir: string;
  riskClass?: RiskClass | null;
  revisionMembers?: AttemptRevisionMember[];
  revisionDigest?: string | null;
  environment?: string | null;
  requiredOutputs?: string[];
  gates?: PipelineGate[];
  /** Extra free-form lines. */
  extras?: string[];
};

/**
 * Build the mandatory bug-context block. Injected whenever an assignment is
 * for reproducer / build / review under an active BugRun.
 */
export function buildBugContext(input: BugContextInput): string {
  const {
    run,
    assignment,
    mode,
    artifactDir,
    riskClass = null,
    revisionMembers = [],
    revisionDigest = assignment.candidateRevisionDigest,
    environment = null,
    requiredOutputs = assignment.acceptanceCriteria,
    gates = [],
    extras = [],
  } = input;

  const policy = modePolicy(mode);
  const memberLines =
    revisionMembers.length === 0
      ? ["  (none)"]
      : revisionMembers.map(
          (m) =>
            `  - ${m.memberKey}: repo=${m.repoRef} branch=${m.branch} sha=${m.headSha}${m.githubResourceId ? ` gh=${m.githubResourceId}` : ""}`,
        );

  const gateLines =
    gates.length === 0
      ? ["  (none)"]
      : gates.map(
          (g) =>
            `  - ${g.gateKind}/${g.memberKey ?? "*"}: ${g.status}${g.subjectSha ? ` sha=${g.subjectSha}` : ""}`,
        );

  const lines = [
    "<bug-context>",
    `bug_run_id: ${run.id}`,
    `channel_id: ${run.channelId}`,
    `thread_id: ${run.threadId}`,
    `artifact_dir: ${artifactDir}`,
    `phase: ${run.phase}`,
    `run_status: ${run.status}`,
    `adaptive_mode: ${mode}`,
    `risk: ${riskClass ?? "unspecified"}`,
    `attempt_id: ${assignment.attemptId ?? run.activeAttemptId ?? ""}`,
    `assignment_id: ${assignment.id}`,
    `target_agent: ${assignment.targetAgent}`,
    `candidate_revision_digest: ${revisionDigest ?? ""}`,
    "revision_members:",
    ...memberLines,
    `environment: ${environment ?? ""}`,
    `required_outputs: ${JSON.stringify(requiredOutputs)}`,
    `allowed_mutations: ${JSON.stringify(
      assignment.mutationScope.length > 0
        ? assignment.mutationScope
        : policy.permittedMutations,
    )}`,
    `required_evidence: ${JSON.stringify(policy.requiredEvidence)}`,
    `deadline_at: ${assignment.deadlineAt ?? run.deadlineAt ?? ""}`,
    `state_version: ${run.stateVersion}`,
    "gates:",
    ...gateLines,
    "rules:",
    "  - Do not infer phase from filesystem layout or Slack thread position.",
    "  - Report a typed outcome (continue_self|handoff|wait|escalate|complete).",
    "  - wait must name a condition and deadline (e.g. devserver.ready).",
    "  - Review alone is not validation for write-path bugs.",
    ...extras.map((e) => `  - ${e}`),
    "</bug-context>",
  ];

  return lines.join("\n");
}

/**
 * Compose bug-context + optional pipeline-assignment block + objective.
 */
export function composeBugDispatchPrompt(input: {
  bugContext: string;
  assignmentContext?: string;
  objective: string;
}): string {
  const parts = [input.bugContext];
  if (input.assignmentContext?.trim()) {
    parts.push(input.assignmentContext.trim());
  }
  const body = input.objective.trim();
  if (body) parts.push(body);
  return parts.join("\n\n");
}

/** Absolute default artifact dir for a bug run (projection root). */
export function defaultBugArtifactDir(
  workspaceRoot: string,
  runId: string,
): string {
  return `${workspaceRoot.replace(/\/$/, "")}/support/bugs/${runId}`;
}
