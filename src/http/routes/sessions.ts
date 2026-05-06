import type { SessionStore } from "../../session/store/interface.ts";

export async function handleSessions(store: SessionStore): Promise<Response> {
  const allSessions = await store.getAll();
  const sessions = [...allSessions.values()]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((s) => {
      // Spread-based projection so new ThreadSession fields surface on the
      // dashboard without per-field plumbing. Explicitly omit fields that
      // are either internal (worktree/cwd/pid/systemPrompt — filesystem
      // paths, kernel state, prompt-engineering details), redundant
      // (agentSessions is reshaped below into `agents`), or non-JSON-safe
      // (slackIdentity has no use in the UI). pendingMessages is replaced
      // with its length to avoid leaking message bodies.
      const {
        worktreePath: _worktreePath,
        worktreePaths: _worktreePaths,
        systemPrompt: _systemPrompt,
        cwd: _cwd,
        pid: _pid,
        slackIdentity: _slackIdentity,
        agentSessions,
        pendingMessages,
        ...rest
      } = s;
      return {
        ...rest,
        activeAgentName: s.activeAgentName ?? null,
        pendingMessages: pendingMessages.length,
        agents: Object.values(agentSessions ?? {})
          .map((a) => ({
            agentName: a.agentName,
            sessionId: a.sessionId,
            status: a.status,
            lastActivity: a.lastActivity,
            pid: a.pid,
            pendingMessages: a.pendingMessages.length,
          }))
          .sort((a, b) => a.agentName.localeCompare(b.agentName)),
      };
    });

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
