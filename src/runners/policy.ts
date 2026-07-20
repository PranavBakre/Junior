/**
 * Provider-neutral permission compiler.
 *
 * Resolves an agent's effective permission intent from (in order):
 *   1. Explicit session/frontmatter `permissions.intent` when it does not
 *      widen the trusted catalog ceiling
 *   2. Trusted agent catalog (`src/agents/manifest.ts`)
 *   3. null → provider "normal" defaults
 *
 * Compiles that intent into Claude / OpenCode / Codex policy surfaces via
 * the existing per-provider mappers (Claude + Codex) and an OpenCode
 * permission object map defined here.
 *
 * Claude has no OS-level filesystem sandbox — do not claim worktree
 * confinement the provider cannot enforce. Use tool restrictions, registered
 * working directories, capability-scoped MCP, and human gates.
 */

import type { Config } from "../config.ts";
import {
  resolveEffectivePermissionIntent,
  type AgentPermissionIntent,
  type AgentPermissions,
} from "../agents/loader.ts";
import {
  listCatalogAgents,
  resolveAgentManifest,
} from "../agents/registry.ts";
import { createSession, type ThreadSession } from "../session/types.ts";
import { mapClaudeRunPolicy, type ClaudeRunPolicy } from "../claude/policy.ts";
import {
  mapCodexRunPolicy,
  type CodexRunPolicy,
} from "../codex-app-server/policy.ts";
import type { OpenCodePermissionConfig } from "../opencode/config.ts";

export interface PermissionSubject {
  agentPermissions?: AgentPermissions;
  activeAgentName?: string | null;
  agentType?: string | null;
}

/**
 * Resolve the effective permission intent for a session/agent.
 * Delegates to loader.resolveEffectivePermissionIntent (catalog-aware).
 */
export function resolveRunPermissionIntent(
  subject: PermissionSubject,
): AgentPermissionIntent | null {
  return resolveEffectivePermissionIntent(
    subject.agentPermissions,
    subject.activeAgentName ?? subject.agentType,
  );
}

/**
 * Read-safe MCP tools for read-only / human-gated agents.
 * Mutating Slack/memory/dispatch tools are NOT included.
 */
export const READ_SAFE_MCP_PERMISSIONS: Record<string, string> = {
  "mcp__slack-bot__slack_read_thread": "allow",
  "mcp__slack-bot__slack_read_channel": "allow",
  "mcp__slack-bot__slack_search": "allow",
  "mcp__slack-bot__slack_search_users": "allow",
  "mcp__slack-bot__memory_recall": "allow",
  "mcp__slack-bot__register_worktree": "allow",
  "mcp__slack-bot__pipeline_get_state": "allow",
  "mcp__playwright__*": "allow",
};

/**
 * OpenCode permission surface for a given intent.
 *
 * - read-only / no-tools: deny edit/write/task; no-tools also denies bash + MCP
 * - human-gated: ask on mutating tools
 * - normal / utility / null: use the configured fallback (typically "allow")
 *
 * Reviewers do not receive arbitrary Bash merely to run tests — verification
 * should go through a pipeline-owned allowlisted runner (Phase 4+).
 */
export function compileOpenCodePermission(options: {
  subject: PermissionSubject;
  fallback?: OpenCodePermissionConfig;
}): OpenCodePermissionConfig {
  const intent = resolveRunPermissionIntent(options.subject);
  const fallback = options.fallback ?? "allow";

  if (intent === "no-tools") {
    return {
      read: "deny",
      glob: "deny",
      grep: "deny",
      edit: "deny",
      write: "deny",
      bash: "deny",
      task: "deny",
      "mcp__*": "deny",
      "*": "deny",
    };
  }

  if (intent === "read-only") {
    return {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      edit: "deny",
      write: "deny",
      // Best-effort: deny shell. Review uses git/gh via provider-specific
      // allowlists on Claude; OpenCode has no equivalent command patterns here.
      bash: "deny",
      task: "deny",
      // Explicit read-safe MCP surface only — never blanket mcp__*.
      ...READ_SAFE_MCP_PERMISSIONS,
      "mcp__*": "deny",
    };
  }

  if (intent === "human-gated") {
    return {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      edit: "ask",
      write: "ask",
      bash: "ask",
      task: "deny",
      // Human-gated roles may use read MCPs freely; mutating MCP tools ask.
      ...READ_SAFE_MCP_PERMISSIONS,
      "mcp__slack-bot__slack_send_message": "ask",
      "mcp__slack-bot__agent_dispatch": "ask",
      "mcp__slack-bot__memory_add": "ask",
      "mcp__*": "ask",
    };
  }

  // normal, utility, or unset — preserve operator-configured fallback.
  return fallback;
}

/** Compile Claude run policy from session + config. */
export function compileClaudePolicy(options: {
  config: Config["claude"];
  session: ThreadSession;
  cwd: string;
}): ClaudeRunPolicy {
  return mapClaudeRunPolicy(options);
}

/** Compile Codex run policy from session + config. */
export function compileCodexPolicy(options: {
  config: Config["codex"];
  session: ThreadSession;
  cwd: string;
}): CodexRunPolicy {
  return mapCodexRunPolicy(options);
}

/**
 * Provider-parity matrix entry for tests and diagnostics.
 * One row per catalog role × resolved intent.
 */
export interface PermissionMatrixRow {
  agentName: string;
  intent: AgentPermissionIntent;
  openCode: OpenCodePermissionConfig;
  claudePermissionMode: string;
  codexSandbox: string;
}

/**
 * Build the permission compilation matrix for all trusted catalog roles.
 * Used by tests to lock provider parity.
 */
export function buildPermissionMatrix(options: {
  claudeConfig: Config["claude"];
  codexConfig: Config["codex"];
  cwd?: string;
  openCodeFallback?: OpenCodePermissionConfig;
}): PermissionMatrixRow[] {
  const cwd = options.cwd ?? "/repo";
  const rows: PermissionMatrixRow[] = [];

  for (const manifest of listCatalogAgents()) {
    const threadSession = createSession("matrix", "matrix");
    threadSession.agentPermissions = {
      intent: null,
      mcp: [],
      tools: [],
    };
    threadSession.activeAgentName = manifest.name;
    threadSession.agentType = manifest.name;

    const intent =
      resolveRunPermissionIntent(threadSession) ?? manifest.permissionIntent;

    const claude = mapClaudeRunPolicy({
      config: options.claudeConfig,
      session: threadSession,
      cwd,
    });
    const codex = mapCodexRunPolicy({
      config: options.codexConfig,
      session: threadSession,
      cwd,
    });
    const openCode = compileOpenCodePermission({
      subject: threadSession,
      fallback: options.openCodeFallback ?? "allow",
    });

    rows.push({
      agentName: manifest.name,
      intent,
      openCode,
      claudePermissionMode: claude.permissionMode,
      codexSandbox: codex.sandbox,
    });
  }

  return rows;
}

/** Catalog role names expected to resolve consistently across providers. */
export const CATALOG_ROLE_NAMES = [
  "default",
  "lead",
  "pm",
  "architect",
  "build",
  "frontend",
  "review",
  "reproducer",
] as const;

/**
 * Assert a target-repo style override cannot widen catalog intent.
 * Returns the effective intent after clamping.
 */
export function effectiveIntentAgainstCatalog(
  agentName: string,
  declared: AgentPermissionIntent | null,
): AgentPermissionIntent | null {
  const manifest = resolveAgentManifest(agentName);
  if (!manifest) return declared;
  // Re-use loader path via a synthetic permissions object.
  return resolveEffectivePermissionIntent(
    { intent: declared, mcp: [], tools: [] },
    agentName,
  );
}
