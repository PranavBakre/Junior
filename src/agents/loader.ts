/**
 * Per-agent preamble context profile. Each flag controls whether the
 * corresponding block in `buildPromptPreamble` is emitted on the first turn.
 *
 * Defaults are ALL TRUE — existing agents that don't declare flags keep their
 * current heavy preamble. Lightweight task agents opt out per-block via
 * frontmatter:
 *
 *   ---
 *   name: pr-summarize
 *   context.workspace: false
 *   context.threadHistory: false
 *   ---
 *
 * Missing flag → true (safe-but-heavy). Unknown `context.*` keys are ignored
 * silently; values must be the literal strings "true" or "false".
 */
export interface AgentContextProfile {
  identity: boolean;
  slack: boolean;
  workspace: boolean;
  threadHistory: boolean;
  threadHistoryLimit: number;
  agentState: boolean;
}

export type AgentPermissionIntent =
  | "read-only"
  | "normal"
  | "human-gated"
  | "utility"
  | "no-tools";

export interface AgentPermissions {
  intent: AgentPermissionIntent | null;
  mcp: string[];
  tools: string[];
}

export const DEFAULT_CONTEXT_PROFILE: AgentContextProfile = {
  identity: true,
  slack: true,
  workspace: true,
  threadHistory: true,
  // Fallback for agents that do not declare `context.threadHistoryLimit`.
  // Public fallback agents are linted to declare a stricter explicit budget.
  threadHistoryLimit: 100,
  agentState: true,
};

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string | null;
  model: string | null;
  common: string[];
  prompt: string;
  context: AgentContextProfile;
  permissions: AgentPermissions;
  /**
   * Optional slack identity declared in frontmatter. Lets private/overlay
   * agents register their visual identity (username + emoji/image URL)
   * without touching the public AGENT_IDENTITIES literal. Username plus at
   * least one visual field must be present to take effect; a partial
   * declaration is ignored.
   */
  username: string | null;
  iconEmoji: string | null;
  imageUrl: string | null;
}

export async function loadAgentDefinition(
  filePath: string,
): Promise<AgentDefinition | null> {
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) return null;

  const content = await file.text();
  const { frontmatter, body } = parseFrontmatter(content);

  return {
    name: frontmatter["name"] ?? "",
    description: frontmatter["description"] ?? "",
    tools: frontmatter["tools"] ?? null,
    model: frontmatter["model"] ?? null,
    common: readCommonProfile(frontmatter),
    prompt: body.trim(),
    context: readContextProfile(frontmatter),
    permissions: readAgentPermissions(frontmatter),
    username: frontmatter["username"] ?? null,
    iconEmoji: frontmatter["iconEmoji"] ?? null,
    imageUrl: frontmatter["imageUrl"] ?? frontmatter["iconUrl"] ?? null,
  };
}

function readCommonProfile(fm: Record<string, string>): string[] {
  const raw = fm.common;
  if (!raw) return ["core"];
  const names = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (names.length === 0) return ["core"];

  const withoutCore = names.filter((name) => name !== "core");
  return ["core", ...withoutCore];
}

function readContextProfile(
  fm: Record<string, string>,
): AgentContextProfile {
  return {
    identity: parseBool(fm["context.identity"]) ?? DEFAULT_CONTEXT_PROFILE.identity,
    slack: parseBool(fm["context.slack"]) ?? DEFAULT_CONTEXT_PROFILE.slack,
    workspace: parseBool(fm["context.workspace"]) ?? DEFAULT_CONTEXT_PROFILE.workspace,
    threadHistory:
      parseBool(fm["context.threadHistory"]) ?? DEFAULT_CONTEXT_PROFILE.threadHistory,
    threadHistoryLimit:
      parsePositiveInt(fm["context.threadHistoryLimit"]) ??
      DEFAULT_CONTEXT_PROFILE.threadHistoryLimit,
    agentState: parseBool(fm["context.agentState"]) ?? DEFAULT_CONTEXT_PROFILE.agentState,
  };
}

function readAgentPermissions(fm: Record<string, string>): AgentPermissions {
  return {
    intent: parsePermissionIntent(
      fm["permissions.intent"] ?? fm["permission.intent"] ?? fm.permission,
    ),
    mcp: parseCsv(fm["permissions.mcp"] ?? fm["permission.mcp"]),
    tools: parseCsv(fm.tools),
  };
}

function parsePermissionIntent(value: string | undefined): AgentPermissionIntent | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "read-only" ||
    normalized === "normal" ||
    normalized === "human-gated" ||
    normalized === "utility" ||
    normalized === "no-tools"
  ) {
    return normalized;
  }
  return "no-tools";
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatter: Record<string, string> = {};

  if (!content.startsWith("---")) {
    return { frontmatter, body: content };
  }

  const firstDelim = content.indexOf("---");
  const secondDelim = content.indexOf("---", firstDelim + 3);

  if (secondDelim === -1) {
    return { frontmatter, body: content };
  }

  const fmBlock = content.slice(firstDelim + 3, secondDelim).trim();
  const body = content.slice(secondDelim + 3);

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}
