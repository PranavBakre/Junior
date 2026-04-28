import type { SessionStore } from "../session/store/interface.ts";

export async function checkOrphanedSessions(
  store: SessionStore,
): Promise<string[]> {
  const sessions = await store.getAll();
  const orphaned: string[] = [];

  for (const [threadId, session] of sessions) {
    let mutated = false;

    // Lead pid (top-level session)
    if (session.status === "busy" && session.pid !== null) {
      let alive = true;
      try {
        process.kill(session.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        session.status = "idle";
        session.pid = null;
        session.lastError = {
          type: "orphaned",
          message: "Process died unexpectedly",
          timestamp: Date.now(),
        };
        mutated = true;
      }
    }

    // Per-agent pids (persistent agent sessions)
    for (const agentSession of Object.values(session.agentSessions ?? {})) {
      if (agentSession.status !== "busy" || agentSession.pid === null) continue;
      let alive = true;
      try {
        process.kill(agentSession.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        agentSession.status = "idle";
        agentSession.pid = null;
        mutated = true;
      }
    }

    if (mutated) {
      await store.set(threadId, session);
      orphaned.push(threadId);
    }
  }

  return orphaned;
}
