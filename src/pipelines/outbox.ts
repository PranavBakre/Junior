import type { PipelineStore } from "./store/interface.ts";
import type { PipelineOutboxRecord } from "./types.ts";
import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";

/**
 * Claim ready outbox items (status=pending, available_at <= now) under a lease.
 */
export async function claimReadyOutbox(
  store: PipelineStore,
  owner: string,
  limit: number,
  leaseMs: number,
): Promise<PipelineOutboxRecord[]> {
  return store.claimOutbox(owner, limit, leaseMs);
}

export async function markDelivered(
  store: PipelineStore,
  id: string,
): Promise<void> {
  return store.markOutboxDelivered(id);
}

/**
 * Reclaim leases whose lease_expires_at has passed so another worker can claim.
 */
export async function reclaimExpiredLeases(
  store: PipelineStore,
  clock: Clock = systemClock,
): Promise<number> {
  return store.reclaimExpiredOutboxLeases(clock.now());
}
