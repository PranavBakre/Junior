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

/**
 * Worker → worker dispatches that bypass the lead-only invariant.
 *
 * Lead always dispatches anything. Workers normally can't dispatch — their
 * directives are stripped and the message is re-routed to lead as plain text.
 * The exceptions are the happy-path chains: thinker's Phase 2 PR-open message
 * dispatches `!review` (for the PR) and, on read-only bugs, `!reproducer
 * validate <branch>` (for fix validation), removing one round-trip each
 * through lead.
 *
 * Add an entry only when the chain is finite and terminates cleanly back at
 * lead (no risk of worker-loops). Keys are source agents; values are the
 * agents they may dispatch. Neither review nor reproducer can dispatch
 * anything — they always terminate back at lead, who handles the merge.
 */
export const WORKER_DISPATCH_ALLOW: Record<string, ReadonlySet<string>> = {
  thinker: new Set(["review", "reproducer"]),
};

export function workerMayDispatch(
  sourceAgent: string,
  targetAgent: string,
): boolean {
  return WORKER_DISPATCH_ALLOW[sourceAgent]?.has(targetAgent) ?? false;
}
