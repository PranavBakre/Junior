import type { AgentIdentity } from "../session/types.ts";

export const AGENT_IDENTITIES: Record<string, AgentIdentity> = {
  // Default Junior — the bot's main face, responds to @mentions in any channel.
  default: { username: "Junior", iconEmoji: ":face_with_cowboy_hat:" },
  // Lead — the bug-pipeline orchestrator. Keeps the Junior brand association
  // but disambiguates from default Junior so `agentForUsername` can resolve
  // self-bot posts back to the right role.
  lead: { username: "Junior (Lead)", iconEmoji: ":face_with_cowboy_hat:" },
  reproducer: { username: "Reproducer", iconEmoji: ":mag:" },
  thinker: { username: "Thinker", iconEmoji: ":wrench:" },
  review: { username: "Reviewer", iconEmoji: ":eyes:" },
  echo: { username: "Echo", iconEmoji: ":speech_balloon:" },
  "onboard-member": { username: "Onboarder", iconEmoji: ":handshake:" },
};

/**
 * Orchestrator agents — they may dispatch any registered worker. Both share
 * the same dispatch power; they differ in slack identity and which channels
 * route to them. The check at the router layer (and dispatch-allow block) uses
 * this set, so adding a new orchestrator is one edit, not a hunt across files.
 */
const ORCHESTRATOR_AGENTS: ReadonlySet<string> = new Set([
  "lead",
  "default",
  "junior",
]);

export function isOrchestratorAgent(agentName: string | null): boolean {
  return !!agentName && ORCHESTRATOR_AGENTS.has(agentName);
}

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

/**
 * Persistent agents this agent may dispatch via `!<agent>`. Lead may dispatch
 * any registered persistent agent; workers are restricted to
 * WORKER_DISPATCH_ALLOW. Returns an empty array for agents with no dispatch
 * capability — they should re-route requests through lead (e.g. via plain
 * commentary that lead's next turn reads).
 */
export function dispatchableAgentsFor(agentName: string): string[] {
  if (isOrchestratorAgent(agentName)) {
    // Orchestrators (lead, default Junior) may dispatch any registered worker.
    // Exclude self, the other orchestrator, and echo.
    return Object.keys(AGENT_IDENTITIES).filter(
      (name) => !isOrchestratorAgent(name) && name !== "echo",
    );
  }
  const allow = WORKER_DISPATCH_ALLOW[agentName];
  return allow ? [...allow] : [];
}

/**
 * Build the `<dispatch-allow>` system-prompt block injected into every agent's
 * Claude session. Single source of truth: the same data the router uses to
 * gate self-bot directives. Without this, agents would learn the rule from
 * their .md file (prose) which can drift from the code (enforcement) — and
 * disallowed directives strip silently with no feedback signal to the worker.
 */
export function buildDispatchAllowBlock(agentName: string): string {
  const allowed = dispatchableAgentsFor(agentName).sort();
  const lines = ["<dispatch-allow>"];
  if (allowed.length === 0) {
    lines.push(
      "You may NOT emit `!<agent>` directives. Any directive you write will be stripped by the router and re-routed to lead as plain text. If you need another agent to act, describe what you need in your Slack message — lead reads the thread and decides whether to dispatch.",
    );
  } else {
    lines.push(
      `You may emit \`!<agent>\` directives for: ${allowed.map((a) => `\`${a}\``).join(", ")}.`,
    );
    lines.push(
      "Any other `!<agent>` directive will be stripped by the router (silently — no error reply). Treat this list as authoritative; if the rule below disagrees with your agent doc, the code wins.",
    );
  }
  lines.push("</dispatch-allow>");
  return lines.join("\n");
}
