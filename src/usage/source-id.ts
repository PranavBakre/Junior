export function sessionTurnSourceId(
  session: {
    threadId: string;
    activeTopLevelMessageTs?: string | null;
    activeTurnGeneration?: string | null;
    currentMessageTs?: string | null;
  },
  agentName: string,
  postedTs?: string,
): string {
  const isTopLevel = agentName === "default";
  const invocationTs = postedTs ?? session.currentMessageTs ?? undefined;
  const turnKey =
    (isTopLevel ? session.activeTopLevelMessageTs : undefined)
    ?? invocationTs
    ?? (isTopLevel && session.activeTurnGeneration
      ? `pending-${session.activeTurnGeneration}`
      : "unknown");
  return `${session.threadId}:${agentName}:${turnKey}`;
}
