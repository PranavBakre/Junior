import type { SessionStore } from "../../session/store/interface.ts";

export async function handleSessions(store: SessionStore): Promise<Response> {
  const allSessions = await store.getAll();
  const sessions = [...allSessions.values()]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((s) => ({
      threadId: s.threadId,
      channel: s.channel,
      status: s.status,
      sessionId: s.sessionId,
      leadSessionId: s.leadSessionId,
      activeAgentName: s.activeAgentName ?? null,
      targetRepo: s.targetRepo,
      baseRef: s.baseRef,
      agentType: s.agentType,
      verbosity: s.verbosity,
      muted: s.muted,
      model: s.model,
      lastActivity: s.lastActivity,
      createdAt: s.createdAt,
      pendingMessages: s.pendingMessages.length,
      lastError: s.lastError,
      agents: Object.values(s.agentSessions ?? {})
        .map((a) => ({
          agentName: a.agentName,
          sessionId: a.sessionId,
          status: a.status,
          lastActivity: a.lastActivity,
          pid: a.pid,
          pendingMessages: a.pendingMessages.length,
        }))
        .sort((a, b) => a.agentName.localeCompare(b.agentName)),
    }));

  return Response.json({ sessions });
}

export async function handleSessionDetail(
  store: SessionStore,
  threadId: string,
): Promise<Response> {
  const session = await store.get(threadId);
  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  return Response.json({ session });
}
