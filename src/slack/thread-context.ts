import type { App } from "@slack/bolt";
import { loadPersona } from "../persona.ts";

interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
}

// Cache channel ID → name so we don't re-fetch every message
const channelNameCache = new Map<string, string>();

async function resolveChannelName(app: App, channelId: string): Promise<string> {
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;

  try {
    const info = await app.client.conversations.info({ channel: channelId });
    const name = info.channel?.name ?? channelId;
    channelNameCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}

/**
 * Build the identity + thread context preamble for Claude.
 * Always includes Junior's persona, channel/thread coordinates, and thread history.
 */
export async function buildPromptPreamble(
  app: App,
  channel: string,
  threadTs: string,
  latestTs: string,
  botUserId?: string,
): Promise<string> {
  const [persona, channelName, threadContext] = await Promise.all([
    loadPersona(),
    resolveChannelName(app, channel),
    fetchThreadHistory(app, channel, threadTs, latestTs, botUserId),
  ]);

  const parts: string[] = [
    `<identity>`,
    persona,
    ``,
    `Your Slack user ID is ${botUserId ?? "unknown"}. Messages from this user ID in the thread are yours.`,
    `</identity>`,
    ``,
    `<slack-context>`,
    `Channel: #${channelName} (${channel})`,
    `Thread: ${threadTs}`,
    `You are responding in this thread. You already have the full thread history below.`,
    `Do NOT use Slack search or read tools to find this thread — you already have all the context you need.`,
    `</slack-context>`,
  ];

  if (threadContext) {
    parts.push("", threadContext);
  }

  return parts.join("\n");
}

async function fetchThreadHistory(
  app: App,
  channel: string,
  threadTs: string,
  latestTs: string,
  botUserId?: string,
): Promise<string | null> {
  try {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      inclusive: true,
      limit: 100,
    });

    if (!result.messages || result.messages.length <= 1) {
      return null;
    }

    const messages: ThreadMessage[] = result.messages
      .filter((m) => m.ts !== latestTs)
      .map((m) => ({
        user: m.user ?? "unknown",
        text: (m.text ?? "").replace(/<@[A-Z0-9]+>\s*/g, "").trim(),
        ts: m.ts!,
        isBot: !!(botUserId && m.user === botUserId),
      }));

    if (messages.length === 0) return null;

    const lines = messages.map((m) => {
      const role = m.isBot ? "Junior (you)" : `User(${m.user})`;
      return `${role}: ${m.text}`;
    });

    return [
      "<thread-context>",
      "The following is the Slack thread history leading up to the current message.",
      "Use this to understand the conversation so far. Respond ONLY to the current message below.",
      "",
      ...lines,
      "</thread-context>",
    ].join("\n");
  } catch (err) {
    console.error("[thread-context] Failed to fetch thread:", err);
    return null;
  }
}
