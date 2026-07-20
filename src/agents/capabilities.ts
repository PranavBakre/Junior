/**
 * Capability-check helpers over the trusted agent catalog.
 *
 * Capabilities describe what a role may do in the pipeline control plane.
 * Provider enforcement is compiled separately via `src/runners/policy.ts`.
 * Merge / release / credentials / production-write / destructive / data-repair
 * are never granted by the catalog — they always require a human gate.
 */

import {
  HUMAN_GATED_CAPABILITIES,
  type AgentCapability,
  type AgentManifest,
  type HumanGatedCapability,
  type MutationPolicy,
} from "./manifest.ts";
import { resolveAgentManifest } from "./registry.ts";

export type CapabilityCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

function manifestOf(
  agent: string | AgentManifest | null | undefined,
): AgentManifest | null {
  if (!agent) return null;
  if (typeof agent === "string") return resolveAgentManifest(agent);
  return agent;
}

/** Whether the agent has an explicit catalog capability. */
export function hasCapability(
  agent: string | AgentManifest | null | undefined,
  capability: AgentCapability,
): boolean {
  const manifest = manifestOf(agent);
  if (!manifest) return false;
  return manifest.capabilities.includes(capability);
}

/**
 * Human-gated capabilities are never granted by the catalog.
 * Always returns false — callers must route through a human gate.
 */
export function hasHumanGatedCapability(
  _agent: string | AgentManifest | null | undefined,
  _capability: HumanGatedCapability,
): boolean {
  return false;
}

export function isHumanGatedCapability(
  capability: string,
): capability is HumanGatedCapability {
  return (HUMAN_GATED_CAPABILITIES as readonly string[]).includes(capability);
}

/** Capability check with a structured reason on failure. */
export function checkCapability(
  agent: string | AgentManifest | null | undefined,
  capability: AgentCapability | HumanGatedCapability,
): CapabilityCheckResult {
  if (isHumanGatedCapability(capability)) {
    return {
      ok: false,
      reason: `capability "${capability}" is independently human-gated and never granted to agents`,
    };
  }
  const manifest = manifestOf(agent);
  if (!manifest) {
    return {
      ok: false,
      reason: "unknown agent — fail closed for capability checks",
    };
  }
  if (!manifest.capabilities.includes(capability)) {
    return {
      ok: false,
      reason: `agent "${manifest.name}" lacks capability "${capability}"`,
    };
  }
  return { ok: true };
}

/**
 * Whether the agent's mutation policy permits product-code / workspace edits.
 * `none` and `human-gated` do not permit unattended product-code mutation.
 */
export function canMutateWorkspace(
  agent: string | AgentManifest | null | undefined,
): boolean {
  const manifest = manifestOf(agent);
  if (!manifest) return false;
  return manifest.mutationPolicy === "workspace";
}

/** Whether the agent may write pipeline-owned artifacts. */
export function canWritePipelineArtifacts(
  agent: string | AgentManifest | null | undefined,
): boolean {
  return hasCapability(agent, "pipeline-artifact-write");
}

/** Whether the agent may perform ordinary worktree code edits. */
export function canEditProductCode(
  agent: string | AgentManifest | null | undefined,
): boolean {
  return (
    hasCapability(agent, "worktree-mutate") ||
    hasCapability(agent, "repo-write")
  ) && canMutateWorkspace(agent);
}

export function mutationPolicyOf(
  agent: string | AgentManifest | null | undefined,
): MutationPolicy | null {
  return manifestOf(agent)?.mutationPolicy ?? null;
}

/**
 * True when the role is confined to read-only product access
 * (review / reproducer / none mutation policy).
 */
export function isReadOnlyRole(
  agent: string | AgentManifest | null | undefined,
): boolean {
  const manifest = manifestOf(agent);
  if (!manifest) return false;
  return (
    manifest.mutationPolicy === "none" ||
    manifest.permissionIntent === "read-only" ||
    manifest.permissionIntent === "no-tools"
  );
}
