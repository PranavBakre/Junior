/**
 * Outbox pump — claim ready items, dispatch assignment wakes, mark delivered.
 * Delivery is at-least-once; consumers (SessionManager dedupe keys + assignment
 * idempotency) must tolerate replay after a crash between commit and ack.
 */

import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import { log } from "../logger.ts";
import type { PipelineStore } from "./store/interface.ts";
import type { PipelineOutboxRecord } from "./types.ts";
import {
  dispatchAssignment,
  type DispatchDeps,
  type PipelineSessionDispatcher,
  type PipelineSessionReader,
  type SlackAuditCallback,
} from "./dispatch.ts";
import { claimReadyOutbox, markDelivered, reclaimExpiredLeases } from "./outbox.ts";

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
      const handled = await handleOutboxItem(deps.store, dispatchDeps, item);
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
  store: PipelineStore,
  dispatchDeps: DispatchDeps,
  item: PipelineOutboxRecord,
): Promise<"delivered" | "failed" | "skipped"> {
  if (
    item.eventType === "assignment.dispatch" ||
    item.eventType === "assignment.continue"
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

    const result = await dispatchAssignment(dispatchDeps, {
      run,
      assignment,
      dedupeKey: `pipeline-outbox:${item.idempotencyKey}`,
    });

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

  if (
    item.eventType === "assignment.wait" ||
    item.eventType === "assignment.escalate"
  ) {
    // Wait/escalate wakes are informational for Phase 4 — audit only via
    // optional payload. Controllers in later phases reduce these into resumes.
    return "skipped";
  }

  // Unknown event types: mark delivered so they don't block the queue forever.
  log.info(
    "pipeline-pump",
    `skipping unknown outbox eventType=${item.eventType} id=${item.id}`,
  );
  return "skipped";
}
