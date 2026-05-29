import type { RunnerKillSignal } from "../runners/types.ts";

export interface TerminateProcessTreeOptions {
  signal?: RunnerKillSignal;
  forceAfterMs?: number;
  waitAfterForceMs?: number;
}

const DEFAULT_FORCE_AFTER_MS = 5_000;
const DEFAULT_WAIT_AFTER_FORCE_MS = 1_000;

/**
 * Kill a managed child process and its descendants.
 *
 * Junior spawns long-running external CLIs in their own process group
 * (`detached: true`). Signalling `-pid` targets that whole group, so wrapper
 * shells cannot leave `bun test`, dev servers, or provider subprocesses behind.
 * The positive-PID fallback keeps tests and any non-detached legacy handles
 * killable.
 */
export function signalProcessTree(
  pid: number | null | undefined,
  signal: RunnerKillSignal = "SIGINT",
): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back below.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

export async function terminateProcessTree(
  pid: number | null | undefined,
  options: TerminateProcessTreeOptions = {},
): Promise<void> {
  if (!pid) return;
  const signal = options.signal ?? "SIGINT";
  const forceAfterMs = options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS;
  const waitAfterForceMs = options.waitAfterForceMs ?? DEFAULT_WAIT_AFTER_FORCE_MS;

  signalProcessTree(pid, signal);
  if (await waitForExit(pid, forceAfterMs)) return;

  signalProcessTree(pid, "SIGKILL");
  await waitForExit(pid, waitAfterForceMs);
}

export function isProcessTreeAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // Fall back below.
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessTreeAlive(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
