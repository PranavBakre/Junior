/**
 * Outbox pump — claim ready items, dispatch assignment wakes, mark delivered.
 * Delivery is at-least-once; consumers (SessionManager dedupe keys + assignment
 * idempotency) must tolerate replay after a crash between commit and ack.
 */

import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import { log } from "../logger.ts";
import type { PipelineStore } from "./store/interface.ts";
import type { Assignment, PipelineOutboxRecord } from "./types.ts";
import {
  dispatchAssignment,
  type DispatchDeps,
  type PipelineSessionDispatcher,
  type PipelineSessionReader,
  type SlackAuditCallback,
} from "./dispatch.ts";
import { claimReadyOutbox, markDelivered, reclaimExpiredLeases } from "./outbox.ts";
import { bugContextForAssignment } from "./bug/controller.ts";
import { productContextForAssignment } from "./product/controller.ts";

export type PumpDeps = {
  store: PipelineStore;
  dispatcher: PipelineSessionDispatcher;
  sessionReader?: PipelineSessionReader;
  audit?: SlackAuditCallback;
  clock?: Clock;
  /** Lease owner id for this pump worker. */
  owner?: string;
  /** Max items claimed per tick. */
  limit?: number;
  /** Lease duration for claimed outbox rows. */
  leaseMs?: number;
  /** Workspace root for bug-context artifact paths. */
  workspaceRoot?: string;
};

export type PumpReport = {
  reclaimed: number;
  claimed: number;
  delivered: number;
  failed: number;
  skipped: number;
  errors: string[];
};

/**
 * Single pump tick: reclaim expired leases, claim ready outbox, dispatch,
 * mark delivered. Safe to call periodically or immediately after an outcome.
 */
export async function pumpOutbox(deps: PumpDeps): Promise<PumpReport> {
  const clock = deps.clock ?? systemClock;
  const owner = deps.owner ?? `pump-${process.pid}`;
  const limit = deps.limit ?? 20;
  const leaseMs = deps.leaseMs ?? 30_000;

  const reclaimed = await reclaimExpiredLeases(deps.store, clock);
  const claimed = await claimReadyOutbox(deps.store, owner, limit, leaseMs);

  const report: PumpReport = {
    reclaimed,
    claimed: claimed.length,
    delivered: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const dispatchDeps: DispatchDeps = {
    dispatcher: deps.dispatcher,
    sessionReader: deps.sessionReader,
    audit: deps.audit,
    alwaysEnqueue: true,
  };

  for (const item of claimed) {
    try {
      const handled = await handleOutboxItem(deps, dispatchDeps, item);
      if (handled === "delivered") {
        await markDelivered(deps.store, item.id);
        report.delivered += 1;
      } else if (handled === "skipped") {
        // Leave leased until expiry so another tick can retry, or mark delivered
        // for non-actionable informational events.
        await markDelivered(deps.store, item.id);
        report.skipped += 1;
      } else {
        report.failed += 1;
        report.errors.push(`${item.id}: dispatch rejected`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed += 1;
      report.errors.push(`${item.id}: ${message}`);
      log.warn(
        "pipeline-pump",
        `outbox item ${item.id} failed: ${message}`,
      );
      // Do not mark delivered — lease expiry will reclaim for replay.
    }
  }

  return report;
}

/**
 * Startup recovery: reclaim leases then pump once.
 */
export async function recoverAndPump(deps: PumpDeps): Promise<PumpReport> {
  return pumpOutbox(deps);
}

async function handleOutboxItem(
  deps: PumpDeps,
  dispatchDeps: DispatchDeps,
  item: PipelineOutboxRecord,
): Promise<"delivered" | "failed" | "skipped"> {
  const store = deps.store;
  if (
    item.eventType === "assignment.dispatch" ||
    item.eventType === "assignment.continue" ||
    item.eventType === "assignment.resume"
  ) {
    const assignmentId =
      item.assignmentId ??
      (typeof item.payload.assignmentId === "string"
        ? item.payload.assignmentId
        : null);
    if (!assignmentId) {
      log.warn("pipeline-pump", `outbox ${item.id} missing assignmentId`);
      return "skipped";
    }

    const assignment = await store.getAssignment(assignmentId);
    if (!assignment) {
      log.warn(
        "pipeline-pump",
        `outbox ${item.id} assignment ${assignmentId} not found`,
      );
      return "skipped";
    }

    const run = await store.getRun(assignment.runId);
    if (!run) {
      log.warn(
        "pipeline-pump",
        `outbox ${item.id} run ${assignment.runId} not found`,
      );
      return "skipped";
    }

    if (run.status === "terminal") {
      return "skipped";
    }

    let bugContext: string | undefined;
    let productContext: string | undefined;
    if (run.kind === "bug") {
      try {
        bugContext = await bugContextForAssignment(
          {
            store,
            clock: deps.clock,
            workspaceRoot: deps.workspaceRoot,
          },
          run,
          assignment,
        );
      } catch (err) {
        log.warn(
          "pipeline-pump",
          `bug-context build failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (run.kind === "product") {
      try {
        productContext = await productContextForAssignment(
          {
            store,
            clock: deps.clock,
            workspaceRoot: deps.workspaceRoot,
          },
          run,
          assignment,
        );
      } catch (err) {
        log.warn(
          "pipeline-pump",
          `product-context build failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const sourceMessageTs =
      typeof item.payload.sourceMessageTs === "string"
        ? item.payload.sourceMessageTs
        : undefined;
    const sourceSlackUserId =
      typeof item.payload.sourceSlackUserId === "string"
        ? item.payload.sourceSlackUserId
        : item.eventType === "assignment.dispatch"
          ? assignment.sourceSlackUserId ?? undefined
          : undefined;
    const result = await dispatchAssignment(
      { ...dispatchDeps, bugContext, productContext },
      {
        run,
        assignment,
        // Resume wakes can carry a human follow-up, a dev-server URL, or a
        // generic recovery instruction. All retain the exact assignment.
        prompt: item.eventType === "assignment.resume"
          ? await buildResumePrompt(store, assignment, item.payload)
          : undefined,
        sourceMessageTs,
        conversationalText:
          item.eventType === "assignment.resume" &&
            typeof item.payload.prompt === "string"
            ? item.payload.prompt
            : item.eventType === "assignment.dispatch"
              ? assignment.objective
              : undefined,
        // Control-plane routing remains synthetic while trusted provenance
        // supplies the conversational author for prompt attribution.
        userId: sourceSlackUserId,
        dedupeKey: `pipeline-outbox:${item.idempotencyKey}`,
        pipelineInvocation: {
          runId: run.id,
          assignmentId: assignment.id,
          dispatchKey: item.idempotencyKey,
          outcomeCountAtDispatch: (await store.listOutcomes(assignment.id)).length,
          retryCount:
            typeof item.payload.recoveryAttempt === "number"
              ? item.payload.recoveryAttempt
              : 0,
        },
      },
    );

    if (result.status === "rejected") {
      log.warn(
        "pipeline-pump",
        `dispatch rejected for ${assignmentId}: ${result.reason ?? ""}`,
      );
      return "failed";
    }
    // buffered and dispatched both count as logical delivery of the outbox item;
    // the session manager owns the durable buffer of the agent message.
    return "delivered";
  }

  if (item.eventType === "assignment.wait") {
    const assignmentId = item.assignmentId ??
      (typeof item.payload.assignmentId === "string"
        ? item.payload.assignmentId
        : null);
    if (!assignmentId) return "skipped";
    const assignment = await store.getAssignment(assignmentId);
    if (!assignment || assignment.status !== "waiting") return "skipped";
    const run = await store.getRun(assignment.runId);
    if (!run || run.status === "terminal") return "skipped";
    const condition = typeof item.payload.conditionName === "string"
      ? item.payload.conditionName
      : "external condition";
    const reason = `Wait deadline expired before ${condition} was satisfied`;
    const receipt = await store.recordOutcomeTransaction({
      outcome: {
        assignmentId: assignment.id,
        expectedRunVersion: run.stateVersion,
        action: "escalate",
        status: "blocked",
        reason,
        evidenceRefs: [],
        artifactRefs: [],
        blockers: [{ kind: "human_gate", detail: reason }],
        checks: [],
        progressFingerprint: `wait-timeout:${item.idempotencyKey}`,
      },
      toPhase: "needs-human",
      actorType: "system",
      actorId: "pipeline-wait-timeout",
      idempotencyKey: `wait-timeout:${item.idempotencyKey}`,
      suppressDispatch: true,
    });
    if (receipt.status === "rejected") return "failed";
    await auditOutbox(deps.audit, run.channelId, run.threadId, `:warning: ${reason}. Assignment \`${assignment.id.slice(0, 8)}\` needs human attention.`);
    return "delivered";
  }

  if (item.eventType === "assignment.escalate") {
    const run = await store.getRun(item.runId);
    if (!run) return "skipped";
    const reason = typeof item.payload.reason === "string"
      ? item.payload.reason
      : "The assignment needs human attention";
    await auditOutbox(deps.audit, run.channelId, run.threadId, `:raising_hand: ${reason}`);
    return "delivered";
  }

  // Unknown event types: mark delivered so they don't block the queue forever.
  log.info(
    "pipeline-pump",
    `skipping unknown outbox eventType=${item.eventType} id=${item.id}`,
  );
  return "skipped";
}

async function buildResumePrompt(
  store: PipelineStore,
  assignment: Assignment,
  payload: Record<string, unknown>,
): Promise<string> {
  if (typeof payload.prompt === "string") {
    // A newly-created human child assignment uses the message as its
    // objective. Do not repeat the same text as a follow-up.
    if (payload.prompt === assignment.objective) {
      return assignment.objective;
    }
    return `${assignment.objective}\n\n[task-follow-up]\n${payload.prompt}`;
  }
  if (typeof payload.readyUrl === "string") {
    return `${assignment.objective}\n\n[devserver.ready] ${payload.readyUrl}`;
  }

  const completedChildAssignmentId =
    typeof payload.completedChildAssignmentId === "string"
      ? payload.completedChildAssignmentId
      : null;
  if (completedChildAssignmentId) {
    const child = await store.getAssignment(completedChildAssignmentId);
    const outcomes = child
      ? await store.listOutcomes(completedChildAssignmentId)
      : [];
    const latestOutcome = outcomes[outcomes.length - 1];
    if (child && latestOutcome) {
      return [
        assignment.objective,
        "",
        "<delegated-result>",
        `completed_child_assignment_id: ${child.id}`,
        `target_agent: ${child.targetAgent}`,
        `child_status: ${child.status}`,
        `outcome_action: ${latestOutcome.action}`,
        `outcome_status: ${latestOutcome.status}`,
        `reason: ${latestOutcome.reason}`,
        `evidence_refs: ${JSON.stringify(latestOutcome.evidenceRefs)}`,
        `artifact_refs: ${JSON.stringify(latestOutcome.artifactRefs)}`,
        `checks: ${JSON.stringify(latestOutcome.checks)}`,
        "instruction: The delegated child has finished. Use this verdict to advance the parent; do not wait for the same child again.",
        "</delegated-result>",
        "",
        "[pipeline.recovery] Resume from durable state without repeating completed mutations. Report a typed outcome before ending.",
      ].join("\n");
    }
  }

  return `${assignment.objective}\n\n[pipeline.recovery] Resume from durable state without repeating completed mutations. Report a typed outcome before ending.`;
}

async function auditOutbox(
  audit: SlackAuditCallback | undefined,
  channelId: string,
  threadId: string,
  text: string,
): Promise<void> {
  if (!audit) return;
  try {
    await audit({ channelId, threadId, text });
  } catch (err) {
    log.warn(
      "pipeline-pump",
      `audit post failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
