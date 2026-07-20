/**
 * Pure snapshot → semantic event + reduction proposal helpers.
 * No I/O; safe for unit tests and shadow reconciler use.
 */

import type {
  GitHubSemanticEvent,
  GitHubSemanticEventType,
  PipelineGitHubResource,
  PipelineGitHubResourceRole,
  ProposedReduction,
  PrSnapshot,
} from "./types.ts";

export type DiffContext = {
  resourceId: string;
  owner: string;
  repo: string;
  number: number;
  observedAt: number;
};

/**
 * Compare previous and next PR snapshots and emit typed semantic differences.
 * First observation (previous === null) emits no events — registration is not
 * a state change. Subsequent polls emit only fields that actually changed.
 */
export function diffPrSnapshots(
  previous: PrSnapshot | null,
  next: PrSnapshot,
  ctx: DiffContext,
): GitHubSemanticEvent[] {
  if (previous == null) {
    return [];
  }

  const events: GitHubSemanticEvent[] = [];

  if (previous.headRefOid !== next.headRefOid) {
    events.push(
      makeEvent("github.pr.head_changed", ctx, {
        previous: { headRefOid: previous.headRefOid },
        next: { headRefOid: next.headRefOid },
        fingerprintPart: `${previous.headRefOid}->${next.headRefOid}`,
      }),
    );
  }

  if (previous.baseRefName !== next.baseRefName) {
    events.push(
      makeEvent("github.pr.base_changed", ctx, {
        previous: { baseRefName: previous.baseRefName },
        next: { baseRefName: next.baseRefName },
        fingerprintPart: `${previous.baseRefName}->${next.baseRefName}`,
      }),
    );
  }

  if (previous.reviewDecision !== next.reviewDecision) {
    events.push(
      makeEvent("github.pr.review_decision_changed", ctx, {
        previous: { reviewDecision: previous.reviewDecision },
        next: { reviewDecision: next.reviewDecision },
        fingerprintPart: `${previous.reviewDecision ?? "null"}->${next.reviewDecision ?? "null"}`,
      }),
    );
  }

  // Checks can change independently of PR updatedAt / head.
  const prevCheckKey = `${previous.checkRollupSha ?? ""}:${previous.checkRollup ?? ""}`;
  const nextCheckKey = `${next.checkRollupSha ?? ""}:${next.checkRollup ?? ""}`;
  if (prevCheckKey !== nextCheckKey) {
    events.push(
      makeEvent("github.pr.checks_changed", ctx, {
        previous: {
          checkRollup: previous.checkRollup,
          checkRollupSha: previous.checkRollupSha,
        },
        next: {
          checkRollup: next.checkRollup,
          checkRollupSha: next.checkRollupSha,
        },
        fingerprintPart: `${prevCheckKey}->${nextCheckKey}`,
      }),
    );
  }

  // Lifecycle transitions. Merged is distinct from closed.
  if (previous.state !== "MERGED" && next.state === "MERGED") {
    events.push(
      makeEvent("github.pr.merged", ctx, {
        previous: { state: previous.state, mergedAt: previous.mergedAt },
        next: { state: next.state, mergedAt: next.mergedAt, headRefOid: next.headRefOid },
        fingerprintPart: `merged:${next.mergedAt ?? next.headRefOid}`,
      }),
    );
  } else if (previous.state === "OPEN" && next.state === "CLOSED") {
    events.push(
      makeEvent("github.pr.closed", ctx, {
        previous: { state: previous.state, closedAt: previous.closedAt },
        next: { state: next.state, closedAt: next.closedAt },
        fingerprintPart: `closed:${next.closedAt ?? "unknown"}`,
      }),
    );
  } else if (
    (previous.state === "CLOSED" || previous.state === "MERGED") &&
    next.state === "OPEN"
  ) {
    // GitHub rarely reopens merged PRs; still model reopened for closed→open.
    events.push(
      makeEvent("github.pr.reopened", ctx, {
        previous: { state: previous.state },
        next: { state: next.state },
        fingerprintPart: `reopened:${previous.state}->OPEN`,
      }),
    );
  }

  return events;
}

/**
 * Head change proposes invalidation of aggregate gates for every active
 * association that points at this resource. Phase 5 only proposes — it does
 * not call replaceAttemptRevision or advance assignments.
 */
export function proposeReductionsForEvents(
  events: GitHubSemanticEvent[],
  associations: ReadonlyArray<
    Pick<
      PipelineGitHubResource,
      "role" | "workstreamKey" | "attemptId" | "active" | "resourceId"
    >
  >,
): ProposedReduction[] {
  const active = associations.filter((a) => a.active);
  const reductions: ProposedReduction[] = [];

  for (const event of events) {
    if (event.type === "github.pr.head_changed") {
      const previousHeadSha = event.previous?.headRefOid ?? "";
      const nextHeadSha = event.next.headRefOid ?? "";
      for (const assoc of active) {
        reductions.push({
          kind: "invalidate_aggregate_gates",
          reason: "head_changed",
          resourceId: event.resourceId,
          attemptId: assoc.attemptId,
          workstreamKey: assoc.workstreamKey,
          previousHeadSha,
          nextHeadSha,
        });
      }
    }

    if (event.type === "github.pr.checks_changed") {
      reductions.push({
        kind: "checks_apply_to_sha",
        resourceId: event.resourceId,
        headSha: event.next.checkRollupSha ?? event.next.headRefOid ?? "",
        checkRollup: event.next.checkRollup ?? null,
      });
    }

    if (event.type === "github.pr.merged") {
      for (const assoc of active) {
        reductions.push({
          kind: "role_specific_merge",
          resourceId: event.resourceId,
          role: assoc.role as PipelineGitHubResourceRole,
          headSha: event.next.headRefOid ?? "",
        });
      }
    }
  }

  return reductions;
}

function makeEvent(
  type: GitHubSemanticEventType,
  ctx: DiffContext,
  parts: {
    previous: Partial<PrSnapshot>;
    next: Partial<PrSnapshot>;
    fingerprintPart: string;
  },
): GitHubSemanticEvent {
  return {
    type,
    resourceId: ctx.resourceId,
    owner: ctx.owner,
    repo: ctx.repo,
    number: ctx.number,
    observedAt: ctx.observedAt,
    previous: parts.previous,
    next: parts.next,
    fingerprint: `${ctx.resourceId}:${type}:${parts.fingerprintPart}`,
  };
}
