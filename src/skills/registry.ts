import { resolve } from "node:path";
import type { AgentCapability } from "../agents/manifest.ts";
import type { AgentPermissions } from "../agents/loader.ts";

export type SkillExecution = "stateless";

export interface TrustedSkillDefinition {
  name: string;
  description: string;
  relativePath: string;
  execution: SkillExecution;
  capabilities: readonly AgentCapability[];
  permissions: AgentPermissions;
}

const SUPPORT_SKILL_ROOT = resolve(
  import.meta.dirname ?? ".",
  "../../support/skills",
);

const SUPPORT_SKILLS: readonly TrustedSkillDefinition[] = [
  {
    name: "nr-research",
    description: "Investigate New Relic telemetry and record bounded pipeline evidence.",
    relativePath: "nr-research/SKILL.md",
    execution: "stateless",
    capabilities: ["pipeline-artifact-write"],
    permissions: {
      intent: "read-only",
      mcp: ["slack-bot"],
      tools: [],
    },
  },
  {
    name: "sentry-fetch",
    description: "Investigate Sentry issues and record bounded pipeline evidence.",
    relativePath: "sentry-fetch/SKILL.md",
    execution: "stateless",
    capabilities: ["pipeline-artifact-write"],
    permissions: {
      intent: "read-only",
      mcp: ["slack-bot"],
      tools: [],
    },
  },
  {
    name: "vercel-status",
    description: "Inspect deployment state and record bounded pipeline evidence.",
    relativePath: "vercel-status/SKILL.md",
    execution: "stateless",
    capabilities: ["pipeline-artifact-write"],
    permissions: {
      intent: "read-only",
      mcp: ["slack-bot"],
      tools: [],
    },
  },
] as const;

const BY_NAME = new Map(SUPPORT_SKILLS.map((skill) => [skill.name, skill]));

export interface ResolvedSkillDefinition extends TrustedSkillDefinition {
  path: string;
}

export function listTrustedSkills(): ResolvedSkillDefinition[] {
  return SUPPORT_SKILLS.map(resolveSkillPath);
}

export function resolveTrustedSkill(
  rawName: string | null | undefined,
): ResolvedSkillDefinition | null {
  const name = rawName?.trim().toLowerCase();
  if (!name) return null;
  const skill = BY_NAME.get(name);
  return skill ? resolveSkillPath(skill) : null;
}

export function skillRunnerAgentName(skillName: string): string {
  return `skill:${skillName}`;
}

function resolveSkillPath(
  skill: TrustedSkillDefinition,
): ResolvedSkillDefinition {
  return {
    ...skill,
    capabilities: [...skill.capabilities],
    permissions: {
      intent: skill.permissions.intent,
      mcp: [...skill.permissions.mcp],
      tools: [...skill.permissions.tools],
    },
    path: resolve(SUPPORT_SKILL_ROOT, skill.relativePath),
  };
}
