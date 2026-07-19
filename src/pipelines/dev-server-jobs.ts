/**
 * Durable dev-server jobs for bug pipeline validation waits.
 *
 * Flow:
 *   request → wait outcome → persist job → acquire → ready URL
 *   → resume exact assignment → release on complete/fail/cancel/deadline
 *
 * Replaces the blind 10-minute sleep + self-bot ready-message path when the
 * typed bug pipeline owns the thread.
 */

import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import { log } from "../logger.ts";
import type {
  DevServerJob,
  DevServerJobCreate,
  DevServerJobStatus,
} from "./types.ts";

/** Store surface for durable dev-server jobs. */
export interface DevServerJobStore {
  createDevServerJob(job: DevServerJobCreate): Promise<DevServerJob>;
  getDevServerJob(id: string): Promise<DevServerJob | undefined>;
  getDevServerJobByAssignment(
    assignmentId: string,
  ): Promise<DevServerJob | undefined>;
  listDevServerJobs(filter?: {
    runId?: string;
    status?: DevServerJobStatus | DevServerJobStatus[];
  }): Promise<DevServerJob[]>;
  updateDevServerJob(
    id: string,
    patch: Partial<
      Pick<
        DevServerJob,
        | "status"
        | "readyUrl"
        | "leaseOwner"
        | "leaseExpiresAt"
        | "pid"
        | "error"
        | "releasedAt"
        | "releaseReason"
        | "deadlineAt"
      >
    >,
  ): Promise<DevServerJob | undefined>;
  /**
   * Idempotent release. Returns true when this call transitioned the job to a
   * terminal release status; false when already released/cancelled/failed/deadline.
   */
  releaseDevServerJob(
    id: string,
    reason: "complete" | "fail" | "cancel" | "deadline" | string,
    error?: string | null,
  ): Promise<boolean>;
  reclaimExpiredDevServerJobs(now?: number): Promise<number>;
}

export const DEVSERVER_READY_CONDITION = "devserver.ready";
export const DEFAULT_DEVSERVER_DEADLINE_MS = 10 * 60_000;

export type RequestDevServerJobInput = {
  id?: string;
  runId: string;
  assignmentId: string;
  channelId: string;
  threadId: string;
  repo: string;
  branch: string;
  deadlineAt?: number;
  deadlineMs?: number;
};

/**
 * Persist a requested job. Idempotent on (assignmentId, repo) so multi-repo
 * !devserver creates one job per repo without overwriting siblings.
 */
export async function requestDevServerJob(
  store: DevServerJobStore,
  input: RequestDevServerJobInput,
  clock: Clock = systemClock,
): Promise<DevServerJob> {
  // Prefer assignment+repo lookup when the store supports listing.
  const existingList = await store.listDevServerJobs({
    runId: input.runId,
  });
  const existing = existingList.find(
    (j) =>
      j.assignmentId === input.assignmentId &&
      j.repo === input.repo &&
      !isTerminalDevServerStatus(j.status),
  );
  if (existing) {
    return existing;
  }
  // Legacy single-assignment unique lookup (pre multi-repo).
  const byAssignment = await store.getDevServerJobByAssignment(
    input.assignmentId,
  );
  if (byAssignment && byAssignment.repo === input.repo) {
    return byAssignment;
  }
  const now = clock.now();
  const deadlineAt =
    input.deadlineAt ??
    now + (input.deadlineMs ?? DEFAULT_DEVSERVER_DEADLINE_MS);
  return store.createDevServerJob({
    id: input.id ?? crypto.randomUUID(),
    runId: input.runId,
    assignmentId: input.assignmentId,
    channelId: input.channelId,
    threadId: input.threadId,
    repo: input.repo,
    branch: input.branch,
    status: "requested",
    deadlineAt,
  });
}

/**
 * Mark job acquiring under a lease owner (queue worker).
 */
export async function markDevServerJobAcquiring(
  store: DevServerJobStore,
  jobId: string,
  leaseOwner: string,
  leaseMs: number,
  clock: Clock = systemClock,
): Promise<DevServerJob | undefined> {
  const now = clock.now();
  return store.updateDevServerJob(jobId, {
    status: "acquiring",
    leaseOwner,
    leaseExpiresAt: now + leaseMs,
  });
}

/**
 * Persist ready URL and clear acquire lease. Caller should then enqueue a
 * resume for the exact waiting assignment.
 */
export async function markDevServerJobReady(
  store: DevServerJobStore,
  jobId: string,
  readyUrl: string,
  pid?: number | null,
): Promise<DevServerJob | undefined> {
  return store.updateDevServerJob(jobId, {
    status: "ready",
    readyUrl,
    pid: pid ?? null,
    leaseOwner: null,
    leaseExpiresAt: null,
    error: null,
  });
}

/**
 * Idempotent single release for success/failure/cancel/deadline.
 */
export async function releaseDevServerJobOnce(
  store: DevServerJobStore,
  jobId: string,
  reason: "complete" | "fail" | "cancel" | "deadline" | string,
  error?: string | null,
): Promise<{ released: boolean; job: DevServerJob | undefined }> {
  const released = await store.releaseDevServerJob(jobId, reason, error);
  const job = await store.getDevServerJob(jobId);
  // Free the filesystem lock if the router registered one for this job.
  try {
    const { invokeDevServerSlotRelease } = await import(
      "./dev-server-slot-releases.ts"
    );
    await invokeDevServerSlotRelease(jobId);
  } catch {
    // non-fatal
  }
  return { released, job };
}

export function isTerminalDevServerStatus(
  status: DevServerJobStatus,
): boolean {
  return (
    status === "released" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "deadline"
  );
}

export function releaseStatusForReason(
  reason: string,
): Extract<DevServerJobStatus, "released" | "failed" | "cancelled" | "deadline"> {
  if (reason === "complete") return "released";
  if (reason === "fail" || reason === "failed") return "failed";
  if (reason === "cancel" || reason === "cancelled") return "cancelled";
  if (reason === "deadline") return "deadline";
  return "released";
}

/**
 * Reclaim jobs past deadline that are still open, and expired acquire leases.
 */
export async function reclaimDevServerJobs(
  store: DevServerJobStore,
  clock: Clock = systemClock,
): Promise<{ deadlineReleased: number; leasesReclaimed: number }> {
  const now = clock.now();
  const open = await store.listDevServerJobs({
    status: ["requested", "queued", "acquiring", "ready"],
  });
  let deadlineReleased = 0;
  for (const job of open) {
    if (job.deadlineAt <= now && !isTerminalDevServerStatus(job.status)) {
      const ok = await store.releaseDevServerJob(
        job.id,
        "deadline",
        "dev-server job deadline exceeded",
      );
      if (ok) deadlineReleased += 1;
    }
  }
  const leasesReclaimed = await store.reclaimExpiredDevServerJobs(now);
  return { deadlineReleased, leasesReclaimed };
}

/**
 * Outbox payload helper when a job becomes ready: resume the exact assignment.
 */
export function devServerReadyOutboxPayload(job: DevServerJob): {
  eventType: "assignment.resume";
  assignmentId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
} {
  return {
    eventType: "assignment.resume",
    assignmentId: job.assignmentId,
    payload: {
      reason: DEVSERVER_READY_CONDITION,
      jobId: job.id,
      readyUrl: job.readyUrl,
      repo: job.repo,
      branch: job.branch,
    },
    idempotencyKey: `devserver.ready:${job.id}:${job.assignmentId}`,
  };
}

export function logDevServerJob(
  action: string,
  job: Pick<DevServerJob, "id" | "runId" | "assignmentId" | "status" | "repo">,
): void {
  log.info(
    "dev-server-jobs",
    `${action} job=${job.id.slice(0, 8)} run=${job.runId.slice(0, 8)} asg=${job.assignmentId.slice(0, 8)} status=${job.status} repo=${job.repo}`,
  );
}
