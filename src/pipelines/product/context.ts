/**
 * Mandatory <product-context> injection for product pipeline assignments.
 * Workers must not infer phase from file existence or thread position.
 */

import type {
  Assignment,
  AttemptRevisionMember,
  PipelineGate,
  ProductRun,
} from "../types.ts";
import {
  PRODUCT_OWNERSHIP,
  type SkipStageReason,
} from "./definition.ts";

export type ProductContextInput = {
  run: ProductRun;
  assignment: Assignment;
  /** Absolute artifact directory for this product run. */
  artifactDir: string;
  revisionMembers?: AttemptRevisionMember[];
  revisionDigest?: string | null;
  skipReasons?: SkipStageReason[];
  requiredWorkstreams?: string[];
  registeredPrKeys?: string[];
  gates?: PipelineGate[];
  /** Extra free-form lines. */
  extras?: string[];
};

/**
 * Build the mandatory product-context block. Injected whenever an assignment
 * is under an active ProductRun.
 */
export function buildProductContext(input: ProductContextInput): string {
  const {
    run,
    assignment,
    artifactDir,
    revisionMembers = [],
    revisionDigest = assignment.candidateRevisionDigest,
    skipReasons = [],
    requiredWorkstreams = [],
    registeredPrKeys = [],
    gates = [],
    extras = [],
  } = input;

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

  const skipLines =
    skipReasons.length === 0
      ? ["  (none)"]
      : skipReasons.map((s) => `  - ${s.stage}: ${s.reason}`);

  const ownershipLines = PRODUCT_OWNERSHIP.map(
    (o) => `  - ${o.role}: ${o.owns.join(", ")}`,
  );

  const lines = [
    "<product-context>",
    `product_run_id: ${run.id}`,
    `channel_id: ${run.channelId}`,
    `thread_id: ${run.threadId}`,
    `artifact_dir: ${artifactDir}`,
    `phase: ${run.phase}`,
    `run_status: ${run.status}`,
    `owner_agent: ${run.ownerAgent}`,
    `attempt_id: ${assignment.attemptId ?? run.activeAttemptId ?? ""}`,
    `assignment_id: ${assignment.id}`,
    `target_agent: ${assignment.targetAgent}`,
    `candidate_revision_digest: ${revisionDigest ?? ""}`,
    "revision_members:",
    ...memberLines,
    `required_workstreams: ${JSON.stringify(requiredWorkstreams)}`,
    `registered_prs: ${JSON.stringify(registeredPrKeys)}`,
    `acceptance_criteria: ${JSON.stringify(
      assignment.acceptanceCriteria.length > 0
        ? assignment.acceptanceCriteria
        : run.acceptanceCriteria,
    )}`,
    `allowed_mutations: ${JSON.stringify(assignment.mutationScope)}`,
    `deadline_at: ${assignment.deadlineAt ?? run.deadlineAt ?? ""}`,
    `state_version: ${run.stateVersion}`,
    "skipped_stages:",
    ...skipLines,
    "ownership:",
    ...ownershipLines,
    "gates:",
    ...gateLines,
    "rules:",
    "  - Do not infer phase from filesystem layout or Slack thread position.",
    "  - Report a typed outcome (continue_self|handoff|wait|escalate|complete).",
    "  - Direct build/fix/implement authorizes scoped work without a redundant go-word.",
    "  - Reviewer is read-only; findings + typed verdict only.",
    "  - Orchestrator owns aggregate verification, PR coordination, and transitions.",
    "  - Human owns material product decisions and final protected-branch merge.",
    "  - Changing any revision member creates a new digest and reopens aggregate gates.",
    "  - Register every PR with role + workstreamKey; multi-PR same repo stays separate.",
    ...extras.map((e) => `  - ${e}`),
    "</product-context>",
  ];

  return lines.join("\n");
}

/**
 * Compose product-context + optional pipeline-assignment block + objective.
 */
export function composeProductDispatchPrompt(input: {
  productContext: string;
  assignmentContext?: string;
  objective: string;
}): string {
  const parts = [input.productContext];
  if (input.assignmentContext?.trim()) {
    parts.push(input.assignmentContext.trim());
  }
  const body = input.objective.trim();
  if (body) parts.push(body);
  return parts.join("\n\n");
}

/** Absolute default artifact dir for a product run. */
export function defaultProductArtifactDir(
  workspaceRoot: string,
  runId: string,
): string {
  return `${workspaceRoot.replace(/\/$/, "")}/support/product/${runId}`;
}
