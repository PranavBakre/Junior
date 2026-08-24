import { resolve } from "node:path";
import type { Config } from "../config.ts";
import type { OpenCodeMcpConfig } from "../opencode/config.ts";
import type { ThreadSession } from "../session/types.ts";
import { buildMixpanelMcpUrl, buildMongoMcpUrl, buildSlackMcpUrl } from "../mcp/context.ts";
import { subjectHasCapability } from "../agents/capabilities.ts";

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
  if (
    subjectHasCapability(session, "github-review-comment") ||
    subjectHasCapability(session, "pipeline-artifact-write") ||
    subjectHasCapability(session, "dispatch") ||
    subjectHasCapability(session, "pipeline-run-start")
  ) {
    allowed.add("slack-bot");
  }
  if (subjectHasCapability(session, "mongodb-read")) {
    allowed.add("mongodb");
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

export function mixpanelMcpUrl(session: ThreadSession): string {
  return buildMixpanelMcpUrl(session);
}

/** Hosted MCP endpoints authenticate with Claude's user OAuth credentials. */
export function figmaMcpUrl(): string {
  return "https://mcp.figma.com/mcp";
}

/** Hosted MCP endpoints authenticate with Claude's user OAuth credentials. */
export function notionMcpUrl(): string {
  return "https://mcp.notion.com/mcp";
}

export function playwrightMcpCommand(): StdioMcpCommand {
  return wrappedStdioMcpCommand(["npx", "@playwright/mcp", "--headless"]);
}

export function needsUserSettings(session: ThreadSession): boolean {
  // Claude stores hosted MCP OAuth credentials at the user level. Only a run
  // that explicitly requested one of those servers may load user settings;
  // all other runs retain project-only settings isolation.
  return wantsMcp(session, "figma") || wantsMcp(session, "notion");
}

export function buildOpenCodeMcpConfig(
  config: Config,
  session: ThreadSession,
): OpenCodeMcpConfig | null {
  if (!config.opencode.mcpEnabled) return null;

  const mcp: OpenCodeMcpConfig = {};
  if (config.opencode.slackMcpEnabled && wantsMcp(session, "slack-bot")) {
    mcp["slack-bot"] = {
      type: "remote",
      url: slackMcpUrl(session),
      enabled: true,
    };
  }
  if (config.opencode.playwrightMcpEnabled && wantsMcp(session, "playwright")) {
    const command = playwrightMcpCommand();
    mcp.playwright = {
      type: "local",
      command: [command.command, ...command.args],
      enabled: true,
    };
  }
  if (
    config.opencode.mixpanelMcpEnabled &&
    wantsMcp(session, "mixpanel") &&
    isFeatureMetricsSession(session)
  ) {
    mcp.mixpanel = {
      type: "remote",
      url: mixpanelMcpUrl(session),
      enabled: true,
    };
  }
  if (config.opencode.mongodbMcpEnabled && wantsMcp(session, "mongodb")) {
    mcp.mongodb = {
      type: "remote",
      url: mongoMcpUrl(session),
      enabled: true,
    };
  }
  if (config.opencode.figmaMcpEnabled !== false && wantsMcp(session, "figma")) {
    mcp.figma = {
      type: "remote",
      url: figmaMcpUrl(),
      enabled: true,
    };
  }
  if (config.opencode.notionMcpEnabled !== false && wantsMcp(session, "notion")) {
    mcp.notion = {
      type: "remote",
      url: notionMcpUrl(),
      enabled: true,
    };
  }

  return Object.keys(mcp).length > 0 ? mcp : null;
}

function isFeatureMetricsSession(session: ThreadSession): boolean {
  return (
    session.agentType === "feature-metrics" ||
    session.activeAgentName === "feature-metrics"
  );
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
