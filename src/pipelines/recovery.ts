import type { PipelineStore } from "./store/interface.ts";
import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import { reclaimExpiredLeases } from "./outbox.ts";

export type RecoveryReport = {
  reclaimedOutboxLeases: number;
};

/**
 * Startup/wake recovery for the pipeline substrate.
 * Phase 2: reclaim expired outbox leases. Later phases add dev-server and
 * GitHub lease recovery.
 */
export async function recoverPipelineRuntime(
  store: PipelineStore,
  clock: Clock = systemClock,
): Promise<RecoveryReport> {
  const reclaimedOutboxLeases = await reclaimExpiredLeases(store, clock);
  return { reclaimedOutboxLeases };
}
