import { resolveAgentManifest } from "../agents/registry.ts";
import { isCapabilitySubset } from "./capabilities.ts";
import type { RunbookRisk } from "./types.ts";

export type ArtifactClass =
  | "memory-claim"
  | "runbook"
  | "agent-extension"
  | "new-agent"
  | "workflow";

export interface ClassificationResult {
  classification: ArtifactClass;
  confidence: number;
  reason: string;
  existingMatch?: { name: string; kind: string };
}

const WORKFLOW_KEYWORDS = [
  "schedule",
  "cron",
  "every day",
  "every hour",
  "daily",
  "weekly",
  "on event",
  "trigger",
  "webhook",
  "automated",
];

export function classifyReusablePattern(
  normalizedIntent: string,
  ownerAgent: string,
  risk: RunbookRisk | null,
  capabilities: string[],
  occurrenceCount: number,
): ClassificationResult {
  void risk;
  if (occurrenceCount <= 1) {
    return {
      classification: "memory-claim",
      confidence: 0.8,
      reason: "single occurrence — store as durable fact or lesson",
    };
  }

  const intentLower = normalizedIntent.toLowerCase();
  if (WORKFLOW_KEYWORDS.some((kw) => intentLower.includes(kw))) {
    return {
      classification: "workflow",
      confidence: 0.7,
      reason: "intent contains scheduling/event-driven keywords",
    };
  }

  const manifest = resolveAgentManifest(ownerAgent);
  if (manifest && capabilities.length > 0) {
    const subset = isCapabilitySubset(capabilities, ownerAgent);
    if (!subset.ok) {
      if (subset.violations.some((v) => v.includes("not found in trusted catalog"))) {
        return {
          classification: "new-agent",
          confidence: 0.6,
          reason: `owner "${ownerAgent}" lacks required capabilities: ${subset.violations.join("; ")}`,
        };
      }
      return {
        classification: "agent-extension",
        confidence: 0.65,
        reason: `owner "${ownerAgent}" exists but lacks: ${subset.violations.join("; ")}`,
      };
    }
  }

  if (!manifest) {
    if (capabilities.length > 0) {
      return {
        classification: "new-agent",
        confidence: 0.6,
        reason: `no catalog entry for "${ownerAgent}" — may need a new agent with explicit capabilities`,
      };
    }
  }

  return {
    classification: "runbook",
    confidence: 0.75,
    reason: "repeated ordered procedure within existing owner capability boundary",
  };
}
