import type { SessionStore } from "../session/store/interface.ts";

export async function cleanupStaleSessions(
  store: SessionStore,
  staleTimeoutMs: number,
): Promise<string[]> {
  const sessions = await store.getAll();
  const cleaned: string[] = [];

  for (const [threadId, session] of sessions) {
    if (Date.now() - session.lastActivity > staleTimeoutMs) {
      if (session.status === "busy") {
        continue;
      }
      await store.delete(threadId);
      cleaned.push(threadId);
    }
  }

  return cleaned;
}
