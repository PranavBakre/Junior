import { describe, expect, it } from "bun:test";
import { terminateProcessTree } from "./process-tree.ts";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("process tree cleanup", () => {
  it("kills descendants when the managed process is a wrapper", async () => {
    const proc = Bun.spawn(
      ["sh", "-c", "sleep 60 & echo $!; wait"],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        detached: true,
      },
    );
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const childPid = Number(new TextDecoder().decode(value).trim());

    try {
      expect(childPid).toBeGreaterThan(0);
      expect(isPidAlive(childPid)).toBe(true);

      await terminateProcessTree(proc.pid, {
        signal: "SIGTERM",
        forceAfterMs: 500,
        waitAfterForceMs: 500,
      });
      await waitFor(() => !isPidAlive(childPid));

      expect(isPidAlive(childPid)).toBe(false);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
});
