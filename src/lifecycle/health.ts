import type { SessionStore } from "../session/store/interface.ts";
import { isPidAlive } from "./process-utils.ts";
import { terminateProcessGroup } from "./process-tree.ts";

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
      const orphanPid = session.pid;
      if (!isPidAlive(orphanPid)) {
        // A wrapper can exit while descendants keep its detached process group
        // alive. Tear down that group before advertising the thread as usable.
        await terminateProcessGroup(orphanPid, { signal: "SIGTERM" });
        await store.mutateThread(threadId, (current) => {
          // Do not clear a newly-owned turn if another path repaired/restarted
          // this thread while process-group teardown was in flight.
          if (current.status !== "busy" || current.pid !== orphanPid) return;
          current.status = "idle";
          current.pid = null;
          current.lastError = {
            type: "interrupted",
            message: "Process died unexpectedly",
            timestamp: now,
          };
          mutated = true;
        });
      }
    }

    // Per-agent pids (persistent agent sessions)
    for (const [agentName, agentSession] of Object.entries(session.agentSessions ?? {})) {
      if (agentSession.status !== "busy" || agentSession.pid === null) continue;
      const orphanPid = agentSession.pid;
      if (!isPidAlive(orphanPid)) {
        // See the top-level repair above: persistent agent wrappers can leave
        // helpers behind after their recorded leader dies.
        await terminateProcessGroup(orphanPid, { signal: "SIGTERM" });
        await store.mutateThread(threadId, (current) => {
          const currentAgent = current.agentSessions?.[agentName];
          // Same generation guard as the top-level repair: a restarted agent
          // must not be downgraded by a stale health-check snapshot.
          if (currentAgent?.status !== "busy" || currentAgent.pid !== orphanPid) return;
          // Not silent idle: mark failed so pipeline/status surfaces interruption.
          currentAgent.status = "failed";
          currentAgent.pid = null;
          current.lastError = {
            type: "interrupted",
            message: `Agent ${currentAgent.agentName} process died unexpectedly`,
            timestamp: now,
          };
          mutated = true;
        });
      }
    }

    if (mutated) {
      orphaned.push(threadId);
    }
  }

  return orphaned;
}
