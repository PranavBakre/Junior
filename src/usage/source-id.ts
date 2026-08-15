export function sessionTurnSourceId(
  session: {
    threadId: string;
    activeTopLevelMessageTs?: string | null;
    activeTurnGeneration?: string | null;
  },
  agentName: string,
  postedTs?: string,
): string {
  const turnKey =
    session.activeTopLevelMessageTs
    ?? postedTs
    ?? (session.activeTurnGeneration
      ? `pending-${session.activeTurnGeneration}`
      : "unknown");
  return `${session.threadId}:${agentName}:${turnKey}`;
}
