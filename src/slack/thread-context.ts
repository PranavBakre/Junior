import type { App } from "@slack/bolt";
import { loadPersona } from "../persona.ts";
import { NO_SLACK_MESSAGE } from "./formatting.ts";

interface ThreadMessage {
  user: string;
  userName: string;
  text: string;
  ts: string;
  isBot: boolean;
  fileNames: string[];
}

// Cache channel ID → name and user ID → display name so we don't re-fetch every message
const channelNameCache = new Map<string, string>();
const userNameCache = new Map<string, string>();

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

async function resolveUserName(app: App, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const info = await app.client.users.info({ user: userId });
    const user = info.user as
      | {
          name?: string;
          real_name?: string;
          profile?: { display_name?: string; real_name?: string };
        }
      | undefined;
    const name =
      user?.profile?.display_name ||
      user?.profile?.real_name ||
      user?.real_name ||
      user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

export async function resolveSlackMentions(
  app: App,
  text: string,
): Promise<string> {
  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const matches = [...text.matchAll(mentionPattern)];
  if (matches.length === 0) return text;

  let resolved = text;
  for (const match of matches) {
    const name = await resolveUserName(app, match[1]);
    resolved = resolved.replace(match[0], `@${name}`);
  }
  return resolved;
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
    ``,
    `If you decide this message does NOT need a reply (e.g. it's noise, already handled, or you've finished silent work), your final response must be exactly the sentinel \`${NO_SLACK_MESSAGE}\` and nothing else — no surrounding text, no explanation, no quotes. Anything else will be posted to the channel verbatim.`,
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

    // TODO: pre-collect unique user IDs and batch-resolve to avoid Slack rate limits on large threads
    const messages: ThreadMessage[] = await Promise.all(result.messages
      .filter((m) => m.ts !== latestTs)
      .map(async (m) => {
        // Extract file names from message attachments
        const files = (m as Record<string, unknown>).files;
        const fileNames: string[] = Array.isArray(files)
          ? (files as Array<Record<string, unknown>>)
              .filter((f) => typeof f.name === "string")
              .map((f) => f.name as string)
          : [];

        const user = m.user ?? "unknown";

        return {
          user,
          userName: user === "unknown" ? user : await resolveUserName(app, user),
          text: (await resolveSlackMentions(app, m.text ?? "")).trim(),
          ts: m.ts!,
          isBot: !!(botUserId && m.user === botUserId),
          fileNames,
        };
      }));

    if (messages.length === 0) return null;

    const lines = messages.map((m) => {
      const role = m.isBot ? "Junior (you)" : `User(${m.userName})`;
      let line = `${role}: ${m.text}`;
      if (m.fileNames.length > 0) {
        const fileNotes = m.fileNames.map((f) => `[shared image: ${f}]`).join(" ");
        line += ` ${fileNotes}`;
      }
      return line;
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
