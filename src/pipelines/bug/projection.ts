/**
 * Human-facing projection for BugRun state.
 * Optional state.json write is a projection only — never read back as authority.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Assignment,
  AttemptRevisionMember,
  BugRun,
  PipelineGate,
  StoredOutcome,
} from "../types.ts";
import { projectRunSummary } from "../projection.ts";
import type { BugMode, EvidenceKind, RiskClass } from "./definition.ts";
import { modePolicy } from "./definition.ts";

export type BugStateProjection = {
  runId: string;
  kind: "bug";
  phase: string;
  status: string;
  mode: BugMode;
  risk: RiskClass | "unspecified";
  ownerAgent: string;
  stateVersion: number;
  terminalOutcome: string | null;
  activeAttemptId: string | null;
  revisionDigest: string | null;
  revisionMembers: AttemptRevisionMember[];
  knownEvidence: EvidenceKind[];
  skippedEvidence: Array<{ kind: EvidenceKind; reason: string }>;
  gates: Array<{
    gateKind: string;
    status: string;
    subjectSha: string | null;
    memberKey: string | null;
  }>;
  openAssignments: Array<{
    id: string;
    targetAgent: string;
    status: string;
    objective: string;
  }>;
  lastOutcome: string | null;
  humanReadable: string;
  /** Projection schema version — not a controller contract. */
  projectionVersion: 1;
  projectedAt: number;
};

export function projectBugState(input: {
  run: BugRun;
  mode: BugMode;
  assignments: Assignment[];
  latestOutcome?: StoredOutcome | null;
  revisionMembers?: AttemptRevisionMember[];
  revisionDigest?: string | null;
  gates?: PipelineGate[];
  knownEvidence?: EvidenceKind[];
  skippedEvidence?: Array<{ kind: EvidenceKind; reason: string }>;
  riskClass?: RiskClass | null;
  now?: number;
}): BugStateProjection {
  const {
    run,
    mode,
    assignments,
    latestOutcome = null,
    revisionMembers = [],
    revisionDigest = null,
    gates = [],
    knownEvidence = [],
    skippedEvidence = [],
    riskClass = null,
    now = Date.now(),
  } = input;

  const summary = projectRunSummary(run, assignments, latestOutcome);
  const policy = modePolicy(mode);

  const humanReadable = [
    summary.humanReadable,
    `mode=${mode}`,
    riskClass ? `risk=${riskClass}` : null,
    revisionDigest ? `rev=${revisionDigest.slice(0, 12)}` : null,
    `evidence=${knownEvidence.length}/${policy.requiredEvidence.length} required`,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    runId: run.id,
    kind: "bug",
    phase: run.phase,
    status: run.status,
    mode,
    risk: riskClass ?? "unspecified",
    ownerAgent: run.ownerAgent,
    stateVersion: run.stateVersion,
    terminalOutcome: run.terminalOutcome,
    activeAttemptId: run.activeAttemptId,
    revisionDigest,
    revisionMembers: revisionMembers.map((m) => ({ ...m })),
    knownEvidence: [...knownEvidence],
    skippedEvidence: skippedEvidence.map((s) => ({ ...s })),
    gates: gates.map((g) => ({
      gateKind: g.gateKind,
      status: g.status,
      subjectSha: g.subjectSha,
      memberKey: g.memberKey,
    })),
    openAssignments: assignments
      .filter(
        (a) =>
          a.status === "pending" ||
          a.status === "leased" ||
          a.status === "waiting",
      )
      .map((a) => ({
        id: a.id,
        targetAgent: a.targetAgent,
        status: a.status,
        objective: a.objective,
      })),
    lastOutcome: summary.lastOutcomeSummary,
    humanReadable,
    projectionVersion: 1,
    projectedAt: now,
  };
}

/**
 * Write a read-only state.json projection. Callers must never load this file
 * back into the controller as authority.
 */
export function writeBugStateProjection(
  artifactDir: string,
  projection: BugStateProjection,
): string {
  const path = join(artifactDir, "state.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
  return path;
}
