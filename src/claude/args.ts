import type { Config } from "../config.ts";
import { resolveEffectivePermissionIntent } from "../agents/loader.ts";
import type { ThreadSession } from "../session/types.ts";
import { mapClaudeRunPolicy } from "./policy.ts";
import { resolveClaudeModel } from "./model.ts";
import { providerSessionMatchesCwd } from "../runners/runtime.ts";

/** Fully-qualified name of the slack-bot MCP approval tool (see src/mcp/approval.ts). */
export const APPROVAL_PERMISSION_TOOL = "mcp__slack-bot__request_permission";

/**
 * Junior provider-baseline system prompt — the Claude-runner equivalent of the
 * codex adapter's `baseInstructions`. Injected ahead of the agent's own
 * `session.systemPrompt` so both layers are present.
 */
export function juniorBaselinePrompt(): string {
  return [
    "You are Junior, a Slack-controlled coding agent running headlessly via the Claude CLI.",
    "Preserve Junior's Slack session semantics and respond with concise, useful final text.",
    "Delegate to sub-agents only when the active Junior agent prompt explicitly asks for parallel or delegated work.",
  ].join("\n");
}

export function buildClaudeArgs(
  session: ThreadSession,
  prompt: string,
  config: Config["claude"],
  cwd: string,
  mcpConfigPath?: string,
): string[] {
  const policy = mapClaudeRunPolicy({ config, session, cwd });
  const intent = resolveEffectivePermissionIntent(
    session.agentPermissions,
    session.activeAgentName ?? session.agentType,
  );
  // Approval is only wired when the slack-bot MCP is actually configured for
  // this run (mcpConfigPath present — the spawner forces slack-bot for
  // human-gated runs). When it isn't (e.g. a session.cwd utility run that skips
  // project MCP), we must NOT advertise --permission-prompt-tool for a tool that
  // won't exist; fall back to the policy's safe `plan` base instead.
  const approvalActive =
    config.approvalEnabled !== false && intent === "human-gated" && mcpConfigPath != null;

  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(config.maxTurns),
  ];

  if (
    session.sessionId &&
    providerSessionMatchesCwd({
      provider: "claude",
      sessionId: session.sessionId,
      sessionCwd: session.sessionCwd,
      cwd,
    })
  ) {
    args.push("--resume", session.sessionId);
  }

  // Two-layer system prompt: Junior baseline, then the agent's composed prompt.
  if (config.baselineEnabled !== false) {
    args.push("--append-system-prompt", juniorBaselinePrompt());
  }
  if (session.systemPrompt) {
    args.push("--append-system-prompt", session.systemPrompt);
  }

  const model = resolveClaudeModel({
    modelClaude: session.modelClaude,
    sessionModel: session.model,
    configDefaultModel: config.defaultModel,
  });
  if (model) {
    args.push("--model", model);
  }

  // Permission surface from the agent's intent. When the Slack approval
  // round-trip is active we need `default` mode (so un-allowed tools consult the
  // prompt tool) rather than the policy's safe `plan` base.
  const permissionMode = approvalActive ? "default" : policy.permissionMode;
  args.push("--permission-mode", permissionMode);
  if (approvalActive) {
    args.push("--permission-prompt-tool", APPROVAL_PERMISSION_TOOL);
  }

  if (policy.allowedTools.length > 0) {
    args.push("--allowedTools", ...policy.allowedTools);
  }
  if (policy.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...policy.disallowedTools);
  }
  // addDirs only carries extra roots beyond cwd (cwd is already accessible).
  const extraDirs = policy.addDirs.filter((dir) => dir !== cwd);
  if (extraDirs.length > 0) {
    args.push("--add-dir", ...extraDirs);
  }

  if (config.maxBudgetUsd != null) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd));
  }

  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }
  // Isolation: only load Junior's generated MCP config (no developer-global
  // `.mcp.json` / user MCP leak), and only project-level settings.
  if (config.strictMcp !== false) {
    args.push("--strict-mcp-config");
  }
  if (config.settingSources) {
    args.push("--setting-sources", config.settingSources);
  }

  return args;
}
