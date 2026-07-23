import type { AgentCapability } from "../agents/manifest.ts";
import { resolveAgentManifest } from "../agents/registry.ts";

export interface CapabilityBundle {
  description: string;
  requiredAgentCapabilities: readonly AgentCapability[];
}

export const CAPABILITY_BUNDLES: Record<string, CapabilityBundle> = {
  "mongo.read": {
    description: "Schema, find, count, and aggregate without mutation",
    requiredAgentCapabilities: ["repo-read"],
  },
  "migration.inspect": {
    description: "Read models and migration scripts",
    requiredAgentCapabilities: ["repo-read"],
  },
  "migration.execute": {
    description: "Execute an approved repository migration path",
    requiredAgentCapabilities: ["repo-read", "repo-write"],
  },
  "slack.read": {
    description: "Read the scoped channel or thread",
    requiredAgentCapabilities: ["repo-read"],
  },
  "slack.post": {
    description: "Post non-secret results in the scoped thread",
    requiredAgentCapabilities: ["repo-read"],
  },
  "credential.deliver": {
    description: "Deliver a credential through the approved private channel",
    requiredAgentCapabilities: ["repo-read"],
  },
  "github.read": {
    description: "Read repository and pull-request state",
    requiredAgentCapabilities: ["repo-read", "github-review-read"],
  },
  "github.propose": {
    description: "Create a branch and pull request through the approved identity",
    requiredAgentCapabilities: ["repo-read", "repo-write"],
  },
};

export function isValidCapabilityBundle(name: string): boolean {
  return name in CAPABILITY_BUNDLES;
}

export function listCapabilityBundles(): string[] {
  return Object.keys(CAPABILITY_BUNDLES);
}

export function isCapabilitySubset(
  requested: string[],
  ownerAgent: string,
): { ok: boolean; violations: string[] } {
  const manifest = resolveAgentManifest(ownerAgent);
  if (!manifest) {
    // Overlay-only agents lack a catalog entry. Validate bundle names only;
    // capability enforcement defers to runtime dispatch policy.
    const violations: string[] = [];
    for (const name of requested) {
      if (!CAPABILITY_BUNDLES[name]) {
        violations.push(`unknown capability bundle "${name}"`);
      }
    }
    return { ok: violations.length === 0, violations };
  }

  const agentCaps = new Set<string>(manifest.capabilities);
  const violations: string[] = [];

  for (const bundleName of requested) {
    const bundle = CAPABILITY_BUNDLES[bundleName];
    if (!bundle) {
      violations.push(`unknown capability bundle "${bundleName}"`);
      continue;
    }
    for (const required of bundle.requiredAgentCapabilities) {
      if (!agentCaps.has(required)) {
        violations.push(
          `capability "${bundleName}" requires agent capability "${required}" not held by "${ownerAgent}"`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
