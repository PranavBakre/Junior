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

    if (session.tmuxSessionName) {
      const cwd = session.sessionCwd;
      if (!cwd) {
        await driver.discardPersistedSession(session.tmuxSessionName);
        session.tmuxSessionName = null;
        session.topLevelTmuxAgent = null;
        session.sessionId = null;
        session.leadSessionId = null;
        session.sessionCwd = null;
        if (session.status === "busy") session.status = "idle";
        await store.set(threadId, session);
        downgraded++;
      } else {
        const live = await driver.tmuxHasSession(session.tmuxSessionName);
        const safeToAdopt = live &&
          await driver.tmuxSessionHasDatabaseCredentialSentinels(session.tmuxSessionName);
        if (safeToAdopt) {
          await driver.adoptExistingSession({
            threadId,
            agentName: session.topLevelTmuxAgent ?? "lead",
            cwd,
            tmuxSessionName: session.tmuxSessionName,
            sessionId: session.sessionId,
          });
          // The bot died mid-turn but tmux survived. We have no activeTurn to
          // resolve, so the next `turn_duration` event would be silently dropped
          // and the row stays busy forever — flip back to idle so new messages
          // can drain. Symmetric to the dead-tmux branch below.
          if (session.status === "busy") {
            session.status = "idle";
            session.lastError = {
              type: "tmux-adopted-mid-turn",
              message: "bot restarted mid-turn; tmux session adopted, in-flight turn dropped",
              timestamp: Date.now(),
            };
            await store.set(threadId, session);
          }
          adopted++;
        } else {
          if (live) await driver.discardPersistedSession(session.tmuxSessionName);
          // The tmux session is gone but we kept the transcript — next send()
          // will cold-start a fresh tmux with --resume <sessionId>.
          session.tmuxSessionName = null;
          if (session.status === "busy") {
            session.status = "idle";
            session.lastError = {
              type: live ? "tmux-credentials-unsanitized" : "tmux-lost",
              message: live
                ? "discarded pre-hardening tmux session with unsafe credential environment"
                : "tmux session died while bot was down",
              timestamp: Date.now(),
            };
          }
          await store.set(threadId, session);
          downgraded++;
        }
      }
    }

    // Per-agent persistent agents
    for (const agentSession of Object.values(session.agentSessions ?? {})) {
      if (!agentSession.tmuxSessionName) continue;
      const agentCwd = agentSession.sessionCwd;
      if (!agentCwd) {
        await driver.discardPersistedSession(agentSession.tmuxSessionName);
        agentSession.tmuxSessionName = null;
        agentSession.sessionId = null;
        agentSession.sessionCwd = null;
        if (agentSession.status === "busy") agentSession.status = "idle";
        await store.set(threadId, session);
        downgraded++;
        continue;
      }
      const live = await driver.tmuxHasSession(agentSession.tmuxSessionName);
      const safeToAdopt = live &&
        await driver.tmuxSessionHasDatabaseCredentialSentinels(agentSession.tmuxSessionName);
      if (safeToAdopt) {
        await driver.adoptExistingSession({
          threadId,
          agentName: agentSession.agentName,
          cwd: agentCwd,
          tmuxSessionName: agentSession.tmuxSessionName,
          sessionId: agentSession.sessionId,
        });
        if (agentSession.status === "busy") {
          agentSession.status = "idle";
          await store.set(threadId, session);
        }
        adopted++;
      } else {
        if (live) await driver.discardPersistedSession(agentSession.tmuxSessionName);
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
