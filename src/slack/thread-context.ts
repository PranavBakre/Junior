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

export interface WorkspaceContext {
  worktreePath: string;
  repoName: string;
  repoPath: string;
  branchName: string;
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
  workspace?: WorkspaceContext | null,
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

  if (workspace) {
    parts.push(
      ``,
      `<workspace>`,
      `Target repo: ${workspace.repoName}`,
      `Worktree (your sandbox): ${workspace.worktreePath}`,
      `Worktree branch: ${workspace.branchName}`,
      `Original repo path (OFF-LIMITS for writes): ${workspace.repoPath}`,
      ``,
      `RULES — non-negotiable:`,
      `1. ALL reads, writes, edits, and shell commands for this task MUST happen inside the worktree at ${workspace.worktreePath}. Your cwd is already set there.`,
      `2. NEVER write, edit, or commit files at ${workspace.repoPath} directly. That path is the shared origin repo and must not be modified — it is shared across all threads.`,
      `3. NEVER \`cd\` out of the worktree to do work. If you need to read a file from another repo for reference only, use an absolute Read path — but do not Edit or Write outside the worktree.`,
      `4. When the task is done, commit on branch \`${workspace.branchName}\` from inside the worktree, push, and open a PR. Never push directly to main.`,
      `5. If you violated any of the above by mistake, stop and report it instead of trying to "clean up" by modifying more files.`,
      `</workspace>`,
    );
  }

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
