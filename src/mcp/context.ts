import type { ThreadSession } from "../session/types.ts";

const MCP_PORT = Number(process.env.MCP_PORT ?? "3456");
const DEFAULT_SLACK_MCP_URL = `http://localhost:${MCP_PORT}/mcp`;
const DEFAULT_MONGODB_MCP_URL = `http://localhost:${MCP_PORT}/mcp/mongodb`;

export interface SlackMcpRunContext {
  agent: string;
  channel: string;
  threadId: string;
}

export function slackMcpAgentForSession(session: ThreadSession): string {
  return session.activeAgentName ?? session.topLevelTmuxAgent ?? topLevelAgentForSession(session);
}

export function buildSlackMcpUrl(session: ThreadSession): string {
  const url = new URL(process.env.SLACK_MCP_URL ?? DEFAULT_SLACK_MCP_URL);
  url.searchParams.set("agent", slackMcpAgentForSession(session));
  url.searchParams.set("channel", session.channel);
  url.searchParams.set("thread", session.threadId);
  return url.toString();
}

export function buildMongoMcpUrl(session: ThreadSession): string {
  const url = new URL(process.env.MONGODB_MCP_URL ?? DEFAULT_MONGODB_MCP_URL);
  url.searchParams.set("agent", slackMcpAgentForSession(session));
  url.searchParams.set("channel", session.channel);
  url.searchParams.set("thread", session.threadId);
  return url.toString();
}

export function parseSlackMcpRunContext(requestUrl: string | undefined): SlackMcpRunContext | null {
  if (!requestUrl) return null;
  const url = new URL(requestUrl, DEFAULT_SLACK_MCP_URL);
  const agent = url.searchParams.get("agent")?.trim();
  const channel = url.searchParams.get("channel")?.trim();
  const threadId = url.searchParams.get("thread")?.trim();
  if (!agent || !channel || !threadId) return null;
  return { agent, channel, threadId };
}

function topLevelAgentForSession(session: ThreadSession): "lead" | "default" {
  if (session.defaultAgent === "lead" || session.agentType === "lead") return "lead";
  return "default";
}
