import type { SessionStore } from "../session/store/interface.ts";

export async function checkOrphanedSessions(
  store: SessionStore,
): Promise<string[]> {
  const sessions = await store.getAll();
  const orphaned: string[] = [];

  for (const [threadId, session] of sessions) {
    if (session.status !== "busy" || session.pid === null) {
      continue;
    }

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
      await store.set(threadId, session);
      orphaned.push(threadId);
    }
  }

  return orphaned;
}
