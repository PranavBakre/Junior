import type { PipelineStore } from "./store/interface.ts";
import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import { reclaimExpiredLeases } from "./outbox.ts";
import { reclaimDevServerJobs } from "./dev-server-jobs.ts";

export type RecoveryReport = {
  reclaimedOutboxLeases: number;
  reclaimedDevServerLeases: number;
  deadlineReleasedDevServerJobs: number;
};

/**
 * Startup/wake recovery for the pipeline substrate.
 * Reclaim expired outbox and dev-server leases; release deadline-expired jobs.
 */
export async function recoverPipelineRuntime(
  store: PipelineStore,
  clock: Clock = systemClock,
): Promise<RecoveryReport> {
  const reclaimedOutboxLeases = await reclaimExpiredLeases(store, clock);
  let reclaimedDevServerLeases = 0;
  let deadlineReleasedDevServerJobs = 0;
  try {
    const dev = await reclaimDevServerJobs(store, clock);
    reclaimedDevServerLeases = dev.leasesReclaimed;
    deadlineReleasedDevServerJobs = dev.deadlineReleased;
  } catch {
    // Store may predate Phase 6 methods in mixed test fixtures.
  }
  return {
    reclaimedOutboxLeases,
    reclaimedDevServerLeases,
    deadlineReleasedDevServerJobs,
  };
}
