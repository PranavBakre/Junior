import type { SessionStore } from "../session/store/interface.ts";

/**
 * Detect dead runner PIDs and mark them interrupted rather than silently idle.
 *
 * Lead sessions: status → idle, lastError.type = "interrupted".
 * Per-agent sessions: status → "failed" (not silent idle), parent lastError
 * records the interruption so !status / dashboard surface the death.
 *
 * Pipeline recovery (`recoverPipelineRuntime`) reclaims leases separately;
 * this path only repairs session map state after process death.
 */
export async function checkOrphanedSessions(
  store: SessionStore,
): Promise<string[]> {
  const sessions = await store.getAll();
  const orphaned: string[] = [];
  const now = Date.now();

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
          type: "interrupted",
          message: "Process died unexpectedly",
          timestamp: now,
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
        // Not silent idle: mark failed so pipeline/status surfaces interruption.
        agentSession.status = "failed";
        agentSession.pid = null;
        session.lastError = {
          type: "interrupted",
          message: `Agent ${agentSession.agentName} process died unexpectedly`,
          timestamp: now,
        };
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
