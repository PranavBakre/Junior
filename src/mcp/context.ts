import type { ThreadSession } from "../session/types.ts";

const MCP_PORT = Number(process.env.MCP_PORT ?? "3456");
const DEFAULT_SLACK_MCP_URL = `http://localhost:${MCP_PORT}/mcp`;
const DEFAULT_MONGODB_MCP_URL = `http://localhost:${MCP_PORT}/mcp/mongodb`;

export interface SlackMcpRunContext {
  agent: string;
  channel: string;
  threadId: string;
  /**
   * Slack user IDs of the humans who have posted in the originating thread
   * (`session.humanParticipants`). Sensitive tools (the WhatsApp archive) are
   * gated on every listed user passing the admin check; an empty list on a
   * runner turn means "no human attributable" and those tools deny.
   */
  users: string[];
}

export function slackMcpAgentForSession(session: ThreadSession): string {
  return session.activeAgentName ?? session.topLevelTmuxAgent ?? topLevelAgentForSession(session);
}

export function buildSlackMcpUrl(session: ThreadSession): string {
  const url = new URL(process.env.SLACK_MCP_URL ?? DEFAULT_SLACK_MCP_URL);
  url.searchParams.set("agent", slackMcpAgentForSession(session));
  url.searchParams.set("channel", session.channel);
  url.searchParams.set("thread", session.threadId);
  url.searchParams.set("users", session.humanParticipants.join(","));
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
  const users = (url.searchParams.get("users") ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  return { agent, channel, threadId, users };
}

function topLevelAgentForSession(session: ThreadSession): "lead" | "default" {
  if (session.defaultAgent === "lead" || session.agentType === "lead") return "lead";
  return "default";
}
