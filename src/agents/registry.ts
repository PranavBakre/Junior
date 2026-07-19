/**
 * Trusted agent registry — resolve operational roles by name.
 *
 * Symbolic `orchestrator` resolves to `lead` for support/bug runs and
 * `default` elsewhere. Target-repo definitions cannot widen trusted
 * operational fields (permission intent, capabilities, handoff edges).
 *
 * @see src/agents/manifest.ts for load-order and trust boundaries
 */

import { log } from "../logger.ts";
import type { AgentPermissionIntent } from "./loader.ts";
import {
  TRUSTED_AGENT_CATALOG,
  type AgentManifest,
  type CatalogPermissionIntent,
  type MutationPolicy,
} from "./manifest.ts";

export type OrchestratorContext = "support" | "default";

/** Restrictiveness rank — higher is more restrictive. */
const INTENT_RESTRICTIVENESS: Record<CatalogPermissionIntent, number> = {
  "no-tools": 4,
  "read-only": 3,
  "human-gated": 2,
  utility: 1,
  normal: 0,
};

const byName = new Map<string, AgentManifest>();
const aliasToName = new Map<string, string>();

for (const entry of TRUSTED_AGENT_CATALOG) {
  byName.set(entry.name, entry);
  for (const alias of entry.aliases ?? []) {
    aliasToName.set(alias, entry.name);
  }
}

/**
 * Canonical name for a catalog agent, resolving aliases (`junior` → `default`).
 * Returns null when the name is not in the trusted catalog.
 */
export function canonicalAgentName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (byName.has(trimmed)) return trimmed;
  return aliasToName.get(trimmed) ?? null;
}

/**
 * Resolve a trusted agent manifest by name or alias.
 * Does not consult target-repo or agents-org prompt files.
 */
export function resolveAgentManifest(name: string): AgentManifest | null {
  const canonical = canonicalAgentName(name);
  if (!canonical) return null;
  return byName.get(canonical) ?? null;
}

/**
 * Symbolic `orchestrator` → `lead` for support/bug runs, `default` elsewhere.
 */
export function resolveOrchestratorName(
  context: OrchestratorContext = "default",
): "lead" | "default" {
  return context === "support" ? "lead" : "default";
}

/**
 * Resolve a handoff target name. Expands symbolic `orchestrator` using context.
 * Concrete names and `human` pass through (aliases are canonicalized).
 */
export function resolveHandoffTarget(
  target: string,
  context: OrchestratorContext = "default",
): string {
  const trimmed = target.trim();
  if (trimmed === "orchestrator") return resolveOrchestratorName(context);
  if (trimmed === "human") return "human";
  return canonicalAgentName(trimmed) ?? trimmed;
}

/**
 * Whether the catalog handoff graph permits source → target.
 * Unknown sources return false (fail closed). `human` is always allowed
 * as a target when the source is catalogued (any role → human escalation).
 */
export function registryAllowsHandoff(
  source: string,
  target: string,
  context: OrchestratorContext = "default",
): boolean {
  const manifest = resolveAgentManifest(source);
  if (!manifest) return false;

  const resolvedTarget = resolveHandoffTarget(target, context);
  if (resolvedTarget === "human") {
    // Every catalog role may escalate to human.
    return (
      manifest.handoffPolicy.mayDelegateTo.includes("human") ||
      manifest.handoffPolicy.mayDelegateTo.includes("orchestrator")
    );
  }

  for (const allowed of manifest.handoffPolicy.mayDelegateTo) {
    const resolvedAllowed = resolveHandoffTarget(allowed, context);
    if (resolvedAllowed === resolvedTarget) return true;
  }
  return false;
}

/**
 * Catalog permission intent for a role, or null if unregistered.
 */
export function catalogPermissionIntent(
  agentName: string | null | undefined,
): AgentPermissionIntent | null {
  if (!agentName) return null;
  const manifest = resolveAgentManifest(agentName);
  return manifest?.permissionIntent ?? null;
}

/**
 * Whether `declared` is at least as restrictive as `ceiling`.
 * Used to prevent target-repo frontmatter from widening intent.
 */
export function isIntentWithinCeiling(
  declared: CatalogPermissionIntent,
  ceiling: CatalogPermissionIntent,
): boolean {
  return INTENT_RESTRICTIVENESS[declared] >= INTENT_RESTRICTIVENESS[ceiling];
}

/**
 * Clamp a declared permission intent to the trusted catalog ceiling.
 * Unknown agents: declared passes through unchanged.
 * Catalog agents: declared may only narrow; widen attempts log and use ceiling.
 */
export function clampPermissionIntent(
  agentName: string | null | undefined,
  declared: AgentPermissionIntent | null,
): AgentPermissionIntent | null {
  const ceiling = catalogPermissionIntent(agentName);
  if (!ceiling) return declared;
  if (!declared) return ceiling;
  if (isIntentWithinCeiling(declared, ceiling)) return declared;
  log.warn(
    "agents",
    `clampPermissionIntent: "${agentName}" declared intent "${declared}" widens catalog ceiling "${ceiling}" — using catalog`,
  );
  return ceiling;
}

/**
 * Operational fields that target-repo overlays must never widen.
 * Returns the trusted catalog values; prompt content is not returned here.
 */
export function trustedOperationalFields(
  agentName: string,
): {
  permissionIntent: CatalogPermissionIntent;
  mutationPolicy: MutationPolicy;
  mayDelegateTo: readonly string[];
  capabilities: readonly string[];
} | null {
  const manifest = resolveAgentManifest(agentName);
  if (!manifest) return null;
  return {
    permissionIntent: manifest.permissionIntent,
    mutationPolicy: manifest.mutationPolicy,
    mayDelegateTo: manifest.handoffPolicy.mayDelegateTo,
    capabilities: manifest.capabilities,
  };
}

/**
 * Whether a trust source may define/widen operational metadata.
 * Target-repo is never trusted for operational fields.
 */
export function isTrustedOperationalSource(
  source: "junior" | "agents-org" | "target-repo",
): boolean {
  return source === "junior" || source === "agents-org";
}

/** All catalog entries (immutable snapshot). */
export function listCatalogAgents(): readonly AgentManifest[] {
  return TRUSTED_AGENT_CATALOG;
}

/** Whether a name (or alias) is a registered operational role. */
export function isCatalogAgent(name: string): boolean {
  return canonicalAgentName(name) !== null;
}

/** Whether the agent is an orchestrator role in the catalog. */
export function isCatalogOrchestrator(name: string): boolean {
  return resolveAgentManifest(name)?.role === "orchestrator";
}
