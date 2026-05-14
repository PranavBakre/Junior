import type { SessionStore } from "../session/store/interface.ts";
import type { TmuxDriver } from "../claude/tmux-driver.ts";
import { log } from "../logger.ts";

/**
 * Walk every persisted session marked driverMode="tmux" and reattach
 * driver state for sessions whose tmux session is still alive. Sessions
 * whose tmux died while the bot was down get their tmuxSessionName
 * cleared so the next turn cold-starts a fresh tmux session with
 * `--resume <sessionId>` against the on-disk transcript — the
 * conversation continues, just in a new tmux session.
 *
 * Called once at boot, before event handlers register. Idempotent.
 */
export async function reconcileTmuxSessions(
  store: SessionStore,
  driver: TmuxDriver,
): Promise<{ adopted: number; downgraded: number }> {
  const sessions = await store.getAll();
  let adopted = 0;
  let downgraded = 0;

  for (const [threadId, session] of sessions) {
    if (session.driverMode !== "tmux") continue;

    // tmux sessions were always launched with a concrete cwd; reuse the
    // session's recorded worktreePath. If the worktree is gone the
    // session can't be safely adopted — leave it for the next send to
    // cold-start.
    const cwd = session.cwd ?? session.worktreePath;
    if (!cwd) continue;

    if (session.tmuxSessionName) {
      const live = await driver.tmuxHasSession(session.tmuxSessionName);
      if (live) {
        await driver.adoptExistingSession({
          threadId,
          agentName: "lead",
          cwd,
          tmuxSessionName: session.tmuxSessionName,
          sessionId: session.sessionId,
        });
        adopted++;
      } else {
        // The tmux session is gone but we kept the transcript — next send()
        // will cold-start a fresh tmux with --resume <sessionId>.
        session.tmuxSessionName = null;
        if (session.status === "busy") {
          session.status = "idle";
          session.lastError = {
            type: "tmux-lost",
            message: "tmux session died while bot was down",
            timestamp: Date.now(),
          };
        }
        await store.set(threadId, session);
        downgraded++;
      }
    }

    // Per-agent persistent agents
    for (const agentSession of Object.values(session.agentSessions ?? {})) {
      if (!agentSession.tmuxSessionName) continue;
      const live = await driver.tmuxHasSession(agentSession.tmuxSessionName);
      if (live) {
        await driver.adoptExistingSession({
          threadId,
          agentName: agentSession.agentName,
          cwd,
          tmuxSessionName: agentSession.tmuxSessionName,
          sessionId: agentSession.sessionId,
        });
        adopted++;
      } else {
        agentSession.tmuxSessionName = null;
        if (agentSession.status === "busy") {
          agentSession.status = "idle";
        }
        await store.set(threadId, session);
        downgraded++;
      }
    }
  }

  log.info("reconcile", `tmux adopted=${adopted} downgraded=${downgraded}`);
  return { adopted, downgraded };
}
