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

  for (const [threadId, session] of sessions) {
    if (session.driverMode !== "tmux") continue;

    if (session.tmuxSessionName && now - session.lastActivity > opts.ttlMs) {
      if (opts.skipBusy && session.status === "busy") continue;
      try {
        await driver.close(threadId, "lead");
      } catch (err) {
        log.warn(
          "tmux-evict",
          `kill failed thread=${threadId} err=${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      session.tmuxSessionName = null;
      await store.set(threadId, session);
      evicted.push(`${threadId}:lead`);
    }

    for (const agentSession of Object.values(session.agentSessions ?? {})) {
      if (!agentSession.tmuxSessionName) continue;
      if (now - agentSession.lastActivity <= opts.ttlMs) continue;
      if (opts.skipBusy && agentSession.status === "busy") continue;
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
