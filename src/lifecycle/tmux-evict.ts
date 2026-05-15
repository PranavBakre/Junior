import type { SessionStore } from "../session/store/interface.ts";
import type { TmuxDriver } from "../claude/tmux-driver.ts";
import { log } from "../logger.ts";

export interface EvictOptions {
  /** Idle TTL — sessions older than now-ttl get killed. */
  ttlMs: number;
  /** Only consider sessions whose persisted status is idle (skip busy). */
  skipBusy?: boolean;
}

/**
 * Single-pass eviction sweep. Kills tmux sessions that have been idle past
 * their TTL. The sqlite row keeps `sessionId` so the next Slack message
 * cold-starts a fresh tmux session via `--resume <sessionId>` against the
 * still-on-disk transcript.
 *
 * Bounds RAM at active-thread scale rather than lifetime-thread scale.
 */
export async function evictIdleTmuxSessions(
  store: SessionStore,
  driver: TmuxDriver,
  opts: EvictOptions,
): Promise<{ evicted: string[] }> {
  const sessions = await store.getAll();
  const now = Date.now();
  const evicted: string[] = [];

  for (const [threadId, snapshot] of sessions) {
    if (snapshot.driverMode !== "tmux") continue;

    if (snapshot.tmuxSessionName && now - snapshot.lastActivity > opts.ttlMs) {
      // Re-read inside the critical section. `sessions` is a snapshot taken
      // at the top of the function; by the time we get here a new turn may
      // have started, flipping status to "busy" or bumping lastActivity. The
      // initial skipBusy check was correct then but stale now.
      const session = await store.get(threadId);
      if (!session || session.driverMode !== "tmux" || !session.tmuxSessionName) continue;
      if (opts.skipBusy && session.status === "busy") continue;
      if (now - session.lastActivity <= opts.ttlMs) continue;

      const topAgent = session.topLevelTmuxAgent ?? "lead";
      try {
        await driver.close(threadId, topAgent);
      } catch (err) {
        log.warn(
          "tmux-evict",
          `kill failed thread=${threadId} err=${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      session.tmuxSessionName = null;
      session.topLevelTmuxAgent = null;
      await store.set(threadId, session);
      evicted.push(`${threadId}:${topAgent}`);
    }

    for (const snapshotAgent of Object.values(snapshot.agentSessions ?? {})) {
      if (!snapshotAgent.tmuxSessionName) continue;
      if (now - snapshotAgent.lastActivity <= opts.ttlMs) continue;
      if (opts.skipBusy && snapshotAgent.status === "busy") continue;
      // Same re-read for per-agent state.
      const session = await store.get(threadId);
      const agentSession = session?.agentSessions?.[snapshotAgent.agentName];
      if (!agentSession || !agentSession.tmuxSessionName) continue;
      if (opts.skipBusy && agentSession.status === "busy") continue;
      if (now - agentSession.lastActivity <= opts.ttlMs) continue;
      try {
        await driver.close(threadId, agentSession.agentName);
      } catch (err) {
        log.warn(
          "tmux-evict",
          `kill failed thread=${threadId} agent=${agentSession.agentName} err=${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      agentSession.tmuxSessionName = null;
      await store.set(threadId, session);
      evicted.push(`${threadId}:${agentSession.agentName}`);
    }
  }

  if (evicted.length > 0) {
    log.info("tmux-evict", `evicted=${evicted.length} (${evicted.join(", ")})`);
  }
  return { evicted };
}
