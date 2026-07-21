import { resolve } from "node:path";
import type { ThreadSession } from "../session/types.ts";
import { buildMongoMcpUrl, buildSlackMcpUrl } from "../mcp/context.ts";
import { hasCapability } from "../agents/capabilities.ts";

export type McpServerName = "slack-bot" | "playwright" | "mixpanel" | "mongodb" | "figma" | "notion";

export interface StdioMcpCommand {
  command: string;
  args: string[];
}

export function allowedMcpServers(session: ThreadSession): Set<McpServerName> {
  const declared = session.agentPermissions?.mcp ?? [];
  const allowed = new Set(
    declared.filter((name): name is McpServerName =>
      name === "slack-bot" ||
      name === "playwright" ||
      name === "mixpanel" ||
      name === "mongodb" ||
      name === "figma" ||
      name === "notion"
    ),
  );
  const agent = session.activeAgentName ?? session.agentType;
  if (
    hasCapability(agent, "github-review-comment") ||
    hasCapability(agent, "pipeline-artifact-write") ||
    hasCapability(agent, "dispatch") ||
    hasCapability(agent, "pipeline-run-start")
  ) {
    allowed.add("slack-bot");
  }
  return allowed;
}

export function wantsMcp(session: ThreadSession, name: McpServerName): boolean {
  return allowedMcpServers(session).has(name);
}

export function slackMcpUrl(session: ThreadSession): string {
  return buildSlackMcpUrl(session);
}

export function mongoMcpUrl(session: ThreadSession): string {
  return buildMongoMcpUrl(session);
}

export function playwrightMcpCommand(): StdioMcpCommand {
  return wrappedStdioMcpCommand(["npx", "@playwright/mcp", "--headless"]);
}

export function mixpanelMcpCommand(): StdioMcpCommand {
  return wrappedStdioMcpCommand([
    "npx",
    "-y",
    "mcp-remote",
    "https://mcp.mixpanel.com/mcp",
  ]);
}

export function needsUserSettings(): boolean {
  // Figma and Notion MCP are unconditionally included and require OAuth tokens
  // stored at the user level (~/.claude/). Always widen setting sources.
  return true;
}

function wrappedStdioMcpCommand(command: string[]): StdioMcpCommand {
  return {
    command: resolve(
      import.meta.dirname ?? ".",
      "../../bin/junior-mcp-stdio-wrapper.js",
    ),
    args: ["--", ...command],
  };
}
