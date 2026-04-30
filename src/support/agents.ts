import type { AgentIdentity } from "../session/types.ts";

export const AGENT_IDENTITIES: Record<string, AgentIdentity> = {
  lead: { username: "Junior", iconEmoji: ":face_with_cowboy_hat:" },
  reproducer: { username: "Reproducer", iconEmoji: ":mag:" },
  thinker: { username: "Thinker", iconEmoji: ":wrench:" },
  review: { username: "Reviewer", iconEmoji: ":eyes:" },
  echo: { username: "Echo", iconEmoji: ":speech_balloon:" },
};

export function isPersistentAgent(agentName: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_IDENTITIES, agentName);
}

export function identityForAgent(agentName: string): AgentIdentity | undefined {
  return AGENT_IDENTITIES[agentName];
}

export function agentForUsername(username?: string): string | null {
  if (!username) return null;

  for (const [agentName, identity] of Object.entries(AGENT_IDENTITIES)) {
    if (identity.username === username) return agentName;
  }

  return null;
}
