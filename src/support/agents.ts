import { loadAgentDefinition } from "../agents/loader.ts";
import { log } from "../logger.ts";
import type { AgentIdentity } from "../session/types.ts";

/**
 * Core agents — part of the open-source architecture. Orchestrators (lead,
 * default) and bug-pipeline workers (reproducer, thinker, review) plus the
 * echo debug agent. Identities live in code because these names are
 * referenced from junior's source (special-cases in `manager.ts`, the
 * `isOrchestratorAgent` set, attribution-suffix logic, etc.) — they're part
 * of the contract any fork of junior inherits.
 *
 * Private / org-specific workers (e.g. an org-specific worker) register
 * their identities via `username` + `iconEmoji` or `imageUrl` frontmatter on
 * their `.md` files, loaded at startup by `loadOverlayIdentities` from the org
 * overlay directory. This keeps the public repo free of org-specific names.
 */
export const AGENT_IDENTITIES: Record<string, AgentIdentity> = {
  // Default Junior — the bot's main face, responds to @mentions in any channel.
  // No iconEmoji: uses the Slack app's configured profile picture instead of
  // overriding it with an emoji. Workers and lead use emoji to distinguish
  // their posts from default Junior.
  default: { username: "Junior" },
  // Lead — the bug-pipeline orchestrator. Keeps the Junior brand association
  // but disambiguates from default Junior so `agentForUsername` can resolve
  // self-bot posts back to the right role.
  lead: { username: "Junior (Lead)", iconEmoji: ":face_with_cowboy_hat:" },
  reproducer: { username: "Reproducer", iconEmoji: ":mag:" },
  thinker: { username: "Thinker", iconEmoji: ":wrench:" },
  review: { username: "Reviewer", iconEmoji: ":eyes:" },
  echo: { username: "Echo", iconEmoji: ":speech_balloon:" },
};

/**
 * Register a slack identity for a private/overlay agent. Called by
 * `loadOverlayIdentities` during startup; can also be called directly by
 * tests. Refuses to override an existing entry — overlay agents shouldn't
 * silently re-skin core ones.
 */
export function registerAgentIdentity(
  name: string,
  identity: AgentIdentity,
): boolean {
  if (AGENT_IDENTITIES[name]) {
    log.warn(
      "agents",
      `registerAgentIdentity: refusing to overwrite existing identity for "${name}" (core agent or duplicate overlay entry)`,
    );
    return false;
  }
  AGENT_IDENTITIES[name] = identity;
  return true;
}

/**
 * Scan a directory of agent `.md` files (typically the org overlay at
 * `agents-org/`) and register slack identities for any agent that declares
 * `username` plus either `iconEmoji` or `imageUrl` in its frontmatter. Files
 * without those fields are skipped silently — agents are free to declare just
 * a prompt without a slack identity (e.g. they only run as Task-tool sub-agents
 * and never post to slack).
 *
 * Idempotent: re-running won't double-register. Call once at startup before
 * any session spawns; the registry is read at call-time by every consumer
 * of `AGENT_IDENTITIES`.
 */
export async function loadOverlayIdentities(dirPath: string): Promise<void> {
  try {
    const glob = new Bun.Glob("*.md");
    const entries: string[] = [];
    for await (const entry of glob.scan({ cwd: dirPath })) {
      entries.push(entry);
    }
    for (const entry of entries) {
      const def = await loadAgentDefinition(`${dirPath}/${entry}`);
      if (!def) continue;
      const hasUsername = !!def.username;
      const hasIcon = !!def.iconEmoji || !!def.imageUrl;
      // Genuine "no slack identity declared" — fine. Many overlay files are
      // pure prompt with no slack-posting role (Task-tool sub-agents, etc.).
      if (!hasUsername && !hasIcon) continue;
      // Identity declared but incomplete — likely a typo. Warn so the author
      // can fix it; without this signal the agent silently has no identity
      // and the next observable failure is at dispatch time.
      if (!hasUsername || !hasIcon) {
        log.warn(
          "agents",
          `loadOverlayIdentities: ${entry} declares ${hasUsername ? "username" : "iconEmoji/imageUrl"} but not ${hasUsername ? "iconEmoji/imageUrl" : "username"} — username plus iconEmoji or imageUrl is required; skipping`,
        );
        continue;
      }
      if (!def.name) {
        log.warn(
          "agents",
          `loadOverlayIdentities: ${entry} declares username + iconEmoji/imageUrl but no name — skipping; add a 'name:' field in frontmatter`,
        );
        continue;
      }
      registerAgentIdentity(def.name, {
        username: def.username!,
        ...(def.iconEmoji ? { iconEmoji: def.iconEmoji } : {}),
        ...(def.imageUrl ? { imageUrl: def.imageUrl } : {}),
      });
    }
  } catch (err) {
    // Directory doesn't exist or not readable — overlay is optional.
    log.info(
      "agents",
      `loadOverlayIdentities(${dirPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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
