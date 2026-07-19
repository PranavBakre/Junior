import type { PipelineStore } from "./store/interface.ts";
import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import { reclaimExpiredLeases } from "./outbox.ts";
import { reclaimDevServerJobs } from "./dev-server-jobs.ts";

export type RecoveryReport = {
  reclaimedOutboxLeases: number;
  reclaimedDevServerLeases: number;
  deadlineReleasedDevServerJobs: number;
  reclaimedGitHubLeases: number;
};

/**
 * Startup/wake recovery for the pipeline substrate.
 *
 * Reclaims expired outbox, dev-server, and GitHub leases so work can resume
 * after process death without stealing live leases.
 *
 * Dead runner processes are handled separately by
 * `checkOrphanedSessions` in `src/lifecycle/health.ts`, which marks them
 * `interrupted` (session lastError + agent status failed) rather than silently
 * idle. Model-session resume remains an optimization; assignment/run/artifact
 * state is always re-injected on dispatch.
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

  let reclaimedGitHubLeases = 0;
  try {
    reclaimedGitHubLeases = await store.reclaimExpiredGitHubResourceLeases(
      clock.now(),
    );
  } catch {
    // Store may predate Phase 5 methods in mixed test fixtures.
  }

  return {
    reclaimedOutboxLeases,
    reclaimedDevServerLeases,
    deadlineReleasedDevServerJobs,
    reclaimedGitHubLeases,
  };
}
