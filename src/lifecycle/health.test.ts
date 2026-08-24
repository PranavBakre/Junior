import { describe, expect, it } from "bun:test";
import { checkOrphanedSessions } from "./health.ts";
import { isProcessTreeAlive, terminateProcessGroup } from "./process-tree.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { createSession } from "../session/types.ts";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function spawnOrphanedWrapper(): Promise<{ leaderPid: number; helperPid: number }> {
  const proc = Bun.spawn(["sh", "-c", "sleep 60 & echo $!"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  const helperPid = Number(new TextDecoder().decode(value).trim());
  await proc.exited;
  return { leaderPid: proc.pid, helperPid };
}

describe("checkOrphanedSessions", () => {
  it("terminates helper descendants before clearing an orphaned leader", async () => {
    const { leaderPid, helperPid } = await spawnOrphanedWrapper();

    const store = new InMemorySessionStore();
    const session = createSession("thread-orphan", "channel-1");
    session.status = "busy";
    session.pid = leaderPid;
    await store.set(session.threadId, session);

    try {
      expect(helperPid).toBeGreaterThan(0);
      expect(isPidAlive(leaderPid)).toBe(false);
      expect(isProcessTreeAlive(leaderPid)).toBe(true);

      await expect(checkOrphanedSessions(store)).resolves.toEqual([session.threadId]);
      await waitFor(() => !isPidAlive(helperPid));

      const repaired = (await store.get(session.threadId))!;
      expect(repaired.status).toBe("idle");
      expect(repaired.pid).toBeNull();
      expect(repaired.lastError?.type).toBe("interrupted");
    } finally {
      await terminateProcessGroup(leaderPid, {
        signal: "SIGKILL",
        forceAfterMs: 100,
        waitAfterForceMs: 100,
      });
    }
  });

  it("terminates helper descendants before failing an orphaned persistent agent", async () => {
    const { leaderPid, helperPid } = await spawnOrphanedWrapper();
    const store = new InMemorySessionStore();
    const session = createSession("thread-agent-orphan", "channel-1");
    session.agentSessions.worker = {
      agentName: "worker",
      provider: "claude",
      sessionId: null,
      status: "busy",
      pendingMessages: [],
      lastActivity: Date.now(),
      pid: leaderPid,
    };
    await store.set(session.threadId, session);

    try {
      await expect(checkOrphanedSessions(store)).resolves.toEqual([session.threadId]);
      await waitFor(() => !isPidAlive(helperPid));

      const repaired = (await store.get(session.threadId))!;
      expect(repaired.agentSessions.worker.status).toBe("failed");
      expect(repaired.agentSessions.worker.pid).toBeNull();
      expect(repaired.lastError?.message).toContain("Agent worker");
    } finally {
      await terminateProcessGroup(leaderPid, {
        signal: "SIGKILL",
        forceAfterMs: 100,
        waitAfterForceMs: 100,
      });
    }
  });
});
