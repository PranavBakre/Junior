import { loadAgentDefinition } from "../agents/loader.ts";
import {
  isCatalogAgent,
  isCatalogOrchestrator,
  listCatalogAgents,
  registryAllowsHandoff,
  resolveAgentManifest,
  type OrchestratorContext,
} from "../agents/registry.ts";
import { log } from "../logger.ts";
import type { AgentIdentity } from "../session/types.ts";

/**
 * Core agents — part of the open-source architecture. Orchestrators (lead,
 * default) and bug-pipeline workers (reproducer, review) plus the
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
 * Worker → worker dispatches that bypass the orchestrator-only invariant.
 *
 * The orchestrator (lead/default) always dispatches anything. Workers normally
 * can't dispatch — their directives are stripped and the message is re-routed
 * to the orchestrator as plain text. Empty since the 3-way merge retired
 * thinker: the orchestrator now runs Phase 1/2 itself and emits `!reproducer` /
 * `!review` directly, so no worker→worker chain remains. reproducer and review
 * always terminate back at the orchestrator, who handles the merge.
 *
 * The mechanism stays: add an entry only when a chain is finite and terminates
 * cleanly back at the orchestrator (no risk of worker-loops). Keys are source
 * agents; values are the agents they may dispatch.
 *
 * The lone `thinker` entry is LEGACY-only: no live path spawns thinker anymore
 * (its definition aliases to default), but a pre-merge thread resumed after
 * this deploy still runs under the "thinker" session name and receives the
 * bug-pipeline preamble, whose Phase-2 exit emits `!reproducer` / `!review`.
 * Without this entry the dispatch-allow block would contradict that preamble
 * ("you may NOT emit directives"). Mirrors thinker's exact pre-merge rights.
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
 * Whether `source` may dispatch/hand off to `target`.
 *
 * Prefers the trusted catalog handoff graph when the source is registered.
 * Falls back to legacy orchestrator power / WORKER_DISPATCH_ALLOW so
 * pre-catalog sessions (e.g. thinker) and overlay-only workers keep working.
 *
 * Slack directive routing still uses `dispatchableAgentsFor` +
 * `workerMayDispatch` (legacy-authoritative) until pipeline mode activates
 * typed handoffs. This function is the forward path for internal/pipeline use.
 */
export function canDispatch(
  sourceAgent: string,
  targetAgent: string,
  context: OrchestratorContext = "default",
): boolean {
  ensureShadowResolve();

  if (targetAgent === "human") {
    // Any known role may escalate to a human.
    if (resolveAgentManifest(sourceAgent)) return true;
    if (isOrchestratorAgent(sourceAgent)) return true;
    return workerMayDispatch(sourceAgent, targetAgent);
  }

  const sourceManifest = resolveAgentManifest(sourceAgent);
  if (sourceManifest) {
    if (registryAllowsHandoff(sourceAgent, targetAgent, context)) {
      return true;
    }
    // Catalog source with no matching edge: fail closed for catalog targets.
    // Overlay-only targets (registered in AGENT_IDENTITIES but not catalog)
    // remain dispatchable by orchestrators via the legacy path below.
    if (isCatalogAgent(targetAgent)) {
      return false;
    }
    if (isCatalogOrchestrator(sourceAgent) || isOrchestratorAgent(sourceAgent)) {
      return (
        isPersistentAgent(targetAgent) &&
        !isOrchestratorAgent(targetAgent) &&
        targetAgent !== "echo"
      );
    }
    return false;
  }

  // Legacy / non-catalog source.
  if (isOrchestratorAgent(sourceAgent)) {
    return (
      (isPersistentAgent(targetAgent) || isCatalogAgent(targetAgent)) &&
      !isOrchestratorAgent(targetAgent) &&
      targetAgent !== "echo"
    );
  }
  return workerMayDispatch(sourceAgent, targetAgent);
}

/**
 * Persistent agents this agent may dispatch via `!<agent>`. Lead may dispatch
 * any registered persistent agent; workers are restricted to
 * WORKER_DISPATCH_ALLOW. Returns an empty array for agents with no dispatch
 * capability — they should re-route requests through lead (e.g. via plain
 * commentary that lead's next turn reads).
 *
 * Legacy-authoritative for Slack routing. Pipeline code should prefer
 * `canDispatch` + the trusted catalog handoff graph.
 */
export function dispatchableAgentsFor(agentName: string): string[] {
  ensureShadowResolve();

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

let shadowResolved = false;

/**
 * Shadow-resolve the trusted catalog against legacy AGENT_IDENTITIES /
 * ORCHESTRATOR_AGENTS / WORKER_DISPATCH_ALLOW and log differences. Legacy
 * constants remain authoritative for Slack routing until pipeline activation.
 */
export function ensureShadowResolve(): void {
  if (shadowResolved) return;
  shadowResolved = true;
  shadowResolveAgentCatalog();
}

/** Test helper — reset the once-flag so shadow resolve can re-run. */
export function resetShadowResolveForTests(): void {
  shadowResolved = false;
}

export function shadowResolveAgentCatalog(): void {
  const divergences: string[] = [];

  // Orchestrator set: every catalog orchestrator should be in ORCHESTRATOR_AGENTS
  // and every legacy orchestrator should resolve in the catalog (junior aliases).
  for (const manifest of listCatalogAgents()) {
    if (manifest.role !== "orchestrator") continue;
    if (!isOrchestratorAgent(manifest.name)) {
      divergences.push(
        `catalog orchestrator "${manifest.name}" missing from ORCHESTRATOR_AGENTS`,
      );
    }
  }
  for (const name of ["lead", "default", "junior"] as const) {
    if (isOrchestratorAgent(name) && !isCatalogOrchestrator(name) && name !== "junior") {
      divergences.push(
        `legacy orchestrator "${name}" missing from trusted catalog`,
      );
    }
    if (name === "junior" && isOrchestratorAgent(name) && !resolveAgentManifest("junior")) {
      divergences.push(`legacy orchestrator alias "junior" missing from catalog aliases`);
    }
  }

  // Identity coverage: catalog roles that post to Slack should have identities.
  // Product roles (pm/architect/build/frontend) intentionally may lack public
  // Slack identities — they are internal/pipeline dispatch targets.
  const slackFacing = new Set(["default", "lead", "review", "reproducer"]);
  for (const name of slackFacing) {
    if (!AGENT_IDENTITIES[name]) {
      divergences.push(`slack-facing catalog agent "${name}" missing AGENT_IDENTITIES entry`);
    }
  }

  // Handoff edges: log catalog edges that legacy worker allow-list lacks, and
  // legacy edges the catalog does not know about.
  for (const manifest of listCatalogAgents()) {
    if (manifest.role === "orchestrator") continue;
    for (const target of manifest.handoffPolicy.mayDelegateTo) {
      if (target === "human" || target === "orchestrator") continue;
      const legacyAllows = workerMayDispatch(manifest.name, target);
      const registryAllows = registryAllowsHandoff(manifest.name, target);
      if (registryAllows && !legacyAllows) {
        divergences.push(
          `handoff ${manifest.name}→${target}: catalog allows, legacy WORKER_DISPATCH_ALLOW denies (shadow)`,
        );
      }
    }
  }
  for (const [source, targets] of Object.entries(WORKER_DISPATCH_ALLOW)) {
    for (const target of targets) {
      if (resolveAgentManifest(source) && !registryAllowsHandoff(source, target)) {
        divergences.push(
          `handoff ${source}→${target}: legacy allows, catalog denies (shadow)`,
        );
      }
    }
  }

  if (divergences.length === 0) {
    log.info("agents", "shadow-resolve: trusted catalog matches legacy constants");
    return;
  }
  for (const line of divergences) {
    log.info("agents", `shadow-resolve: ${line}`);
  }
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
