import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ThreadSession } from "../session/types.ts";

const MCP_PORT = Number(process.env.MCP_PORT ?? "3456");
const DEFAULT_SLACK_MCP_URL = `http://localhost:${MCP_PORT}/mcp`;
const DEFAULT_MONGODB_MCP_URL = `http://localhost:${MCP_PORT}/mcp/mongodb`;

/** Default token lifetime for signed MCP run context (2 hours). */
const MCP_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;
const EPHEMERAL_MCP_CONTEXT_SECRET = randomBytes(32).toString("hex");

export interface SlackMcpRunContext {
  agent: string;
  channel: string;
  threadId: string;
  /** Authenticated Slack message timestamp for this runner turn, when present. */
  messageTs?: string | null;
  /**
   * True when the context was verified via HMAC signature (or internal bypass).
   * Unsigned/spoofable query-only contexts are rejected when a secret is configured.
   */
  signed: boolean;
}

export function slackMcpAgentForSession(session: ThreadSession): string {
  // A top-level default slot can load a specialist prompt through agentType
  // (CHANNEL_DEFAULTS or !agent commands). Sign as that actual prompt role so
  // it cannot inherit default's orchestrator capabilities accidentally.
  if (
    session.activeAgentName === "default" &&
    session.agentType &&
    session.agentType !== "default"
  ) {
    return session.agentType;
  }
  return session.activeAgentName ?? session.topLevelTmuxAgent ?? topLevelAgentForSession(session);
}

/**
 * Secret used to sign MCP run-context URLs. Prefer a stable operator-provided
 * MCP_CONTEXT_SECRET; otherwise use a process-local random secret. The fallback
 * intentionally does not use SLACK_BOT_TOKEN because that token is available to
 * spawned runners and therefore cannot authenticate their claimed agent identity.
 */
export function mcpContextSecret(): string {
  const explicit = process.env.MCP_CONTEXT_SECRET?.trim();
  if (explicit) return explicit;
  return EPHEMERAL_MCP_CONTEXT_SECRET;
}

export function buildSlackMcpUrl(session: ThreadSession): string {
  const url = new URL(process.env.SLACK_MCP_URL ?? DEFAULT_SLACK_MCP_URL);
  applySignedRunContext(url, {
    agent: slackMcpAgentForSession(session),
    channel: session.channel,
    threadId: session.threadId,
    messageTs:
      session.currentMessageTs ?? session.activeTopLevelMessageTs ?? null,
  });
  return url.toString();
}

export function buildMongoMcpUrl(session: ThreadSession): string {
  const url = new URL(process.env.MONGODB_MCP_URL ?? DEFAULT_MONGODB_MCP_URL);
  applySignedRunContext(url, {
    agent: slackMcpAgentForSession(session),
    channel: session.channel,
    threadId: session.threadId,
    messageTs:
      session.currentMessageTs ?? session.activeTopLevelMessageTs ?? null,
  });
  return url.toString();
}

function applySignedRunContext(
  url: URL,
  ctx: {
    agent: string;
    channel: string;
    threadId: string;
    messageTs: string | null;
  },
): void {
  url.searchParams.set("agent", ctx.agent);
  url.searchParams.set("channel", ctx.channel);
  url.searchParams.set("thread", ctx.threadId);
  if (ctx.messageTs) url.searchParams.set("message_ts", ctx.messageTs);
  const secret = mcpContextSecret();
  const exp = String(Date.now() + MCP_CONTEXT_TTL_MS);
  url.searchParams.set("exp", exp);
  url.searchParams.set(
    "sig",
    signRunContext(
      secret,
      ctx.agent,
      ctx.channel,
      ctx.threadId,
      exp,
      ctx.messageTs,
    ),
  );
}

export function signRunContext(
  secret: string,
  agent: string,
  channel: string,
  threadId: string,
  exp: string,
  messageTs: string | null = null,
): string {
  return createHmac("sha256", secret)
    .update(`${agent}\n${channel}\n${threadId}\n${exp}\n${messageTs ?? ""}`)
    .digest("hex");
}

/**
 * Parse and authenticate MCP run context from the request URL.
 *
 * A valid HMAC `sig` plus unexpired `exp` is always required. Spoofed
 * agent/channel/thread query params alone are rejected.
 */
export function parseSlackMcpRunContext(
  requestUrl: string | undefined,
): SlackMcpRunContext | null {
  if (!requestUrl) return null;
  const url = new URL(requestUrl, DEFAULT_SLACK_MCP_URL);
  const agent = url.searchParams.get("agent")?.trim();
  const channel = url.searchParams.get("channel")?.trim();
  const threadId = url.searchParams.get("thread")?.trim();
  const messageTs = url.searchParams.get("message_ts")?.trim() || null;
  if (!agent || !channel || !threadId) return null;

  const secret = mcpContextSecret();

  const exp = url.searchParams.get("exp")?.trim();
  const sig = url.searchParams.get("sig")?.trim();
  if (!exp || !sig) return null;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return null;

  const expected = signRunContext(
    secret,
    agent,
    channel,
    threadId,
    exp,
    messageTs,
  );
  if (!safeEqualHex(sig, expected)) return null;

  return { agent, channel, threadId, messageTs, signed: true };
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function topLevelAgentForSession(session: ThreadSession): "lead" | "default" {
  if (session.defaultAgent === "lead" || session.agentType === "lead") return "lead";
  return "default";
}
