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
  if (signalProcessGroup(pid, signal)) return;
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

/**
 * Terminate a detached process group without ever falling back to its former
 * leader PID.
 *
 * Health repair calls this after it has established that the recorded leader
 * exited. At that point a direct PID signal could race PID reuse; the only
 * process we still own is the group identified by the original leader PID.
 */
export async function terminateProcessGroup(
  pid: number | null | undefined,
  options: TerminateProcessTreeOptions = {},
): Promise<void> {
  if (!pid || !isProcessGroupAlive(pid)) return;
  const signal = options.signal ?? "SIGINT";
  const forceAfterMs = options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS;
  const waitAfterForceMs = options.waitAfterForceMs ?? DEFAULT_WAIT_AFTER_FORCE_MS;

  signalProcessGroup(pid, signal);
  if (await waitForProcessGroupExit(pid, forceAfterMs)) return;

  signalProcessGroup(pid, "SIGKILL");
  await waitForProcessGroupExit(pid, waitAfterForceMs);
}

export function isProcessTreeAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  if (isProcessGroupAlive(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid: number, signal: RunnerKillSignal | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  return signalProcessGroup(pid, 0);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessTreeAlive(pid);
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessGroupAlive(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
