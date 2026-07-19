/**
 * In-process registry of filesystem lock release callbacks for durable
 * dev-server jobs. The router registers the proper-lockfile release when it
 * acquires a slot; pipeline controllers invoke it when the durable job is
 * released (complete/fail/cancel/deadline) so the FS slot is not held for the
 * full 10-minute deadline after validation finishes.
 */

const releases = new Map<string, () => Promise<void>>();

export function registerDevServerSlotRelease(
  jobId: string,
  release: () => Promise<void>,
): void {
  releases.set(jobId, release);
}

export async function invokeDevServerSlotRelease(jobId: string): Promise<void> {
  const release = releases.get(jobId);
  if (!release) return;
  releases.delete(jobId);
  try {
    await release();
  } catch {
    // Non-fatal — deadline timer is a backstop.
  }
}

export function clearDevServerSlotRelease(jobId: string): void {
  releases.delete(jobId);
}
