import type { App } from "@slack/bolt";
import type { RepoConfig } from "../config.ts";
import { loadPersona } from "../persona.ts";
import { NO_SLACK_MESSAGE } from "./formatting.ts";
import type { AgentContextProfile } from "../agents/loader.ts";
import { DEFAULT_CONTEXT_PROFILE } from "../agents/loader.ts";

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

  // Pre-resolve unique IDs in parallel, then replace in one pass.
  // Single-pass replace (regex + callback) avoids re-matching inside prior
  // replacements when the same user is mentioned more than once.
  const uniqueIds = [...new Set(matches.map((m) => m[1]))];
  const nameMap = new Map(
    await Promise.all(
      uniqueIds.map(async (id) => [id, await resolveUserName(app, id)] as const),
    ),
  );

  return text.replace(mentionPattern, (_, userId: string) => {
    const name = nameMap.get(userId) ?? userId;
    return `@${name} (<@${userId}>)`;
  });
}

export interface WorkspaceContext {
  worktreePath: string;
  repoName: string;
  repoPath: string;
  branchName: string;
}

/**
 * Build the standalone workspace-rules block. Used in the full preamble on the
 * first turn AND on resumed turns (cheap insurance — keeps the safety rule
 * present even when --resume carries the rest of the context).
 *
 * When `worktreePaths` is provided and non-empty, renders the multi-repo format
 * for bug-pipeline threads. Otherwise falls through to the single-repo format
 * using `workspace`.
 */
export function buildWorkspaceBlock(
  workspace: WorkspaceContext | null | undefined,
  worktreePaths?: Record<string, string>,
  repos?: RepoConfig[],
  threadId?: string,
): string | null {
  // Multi-repo format for bug-pipeline threads.
  if (worktreePaths && Object.keys(worktreePaths).length > 0) {
    const repoBlocks = Object.entries(worktreePaths).map(([repoName, wPath]) => {
      const repoConfig = repos?.find((r) => r.name === repoName);
      const branch = threadId ? `slack/${threadId}` : "slack/<thread>";
      const base = repoConfig?.defaultBase ?? "origin/main";
      const lines = [
        `repo: ${repoName}`,
        `  worktree (your sandbox): ${wPath}`,
      ];
      if (repoConfig?.path) {
        lines.push(`  bare repo (OFF-LIMITS):  ${repoConfig.path}`);
      }
      lines.push(
        `  branch:                 ${branch}`,
        `  base:                   ${base}`,
      );
      return lines.join("\n");
    });

    return [
      `<workspace>`,
      `You have isolated git worktrees for this thread. The bare repos at the`,
      `paths shown below are shared across all threads — DO NOT touch them.`,
      `Work ONLY inside the worktree paths listed below.`,
      ``,
      ...repoBlocks.flatMap((block, i) => (i < repoBlocks.length - 1 ? [block, ""] : [block])),
      ``,
      `RULES — non-negotiable:`,
      `1. ALL reads, writes, edits, and git commands MUST happen inside the worktree paths listed above.`,
      `2. NEVER write, edit, or commit files at any bare-repo path listed above — those are the shared origin repos.`,
      `3. NEVER \`cd\` out of your worktree to do work. Read-only references to other paths are OK via absolute Read paths, but do not Edit or Write outside the worktrees.`,
      `4. NEVER run dev servers yourself — post \`!devserver <branch>\` instead.`,
      `</workspace>`,
    ].join("\n");
  }

  // Single-repo format (existing !repo flow).
  if (!workspace) return null;
  return [
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
  ].join("\n");
}

/**
 * Build the identity + thread context preamble for Claude.
 * Always includes Junior's persona, channel/thread coordinates, and thread history.
 *
 * Pass `worktreePaths` + `repos` for bug-pipeline threads to render the multi-repo
 * workspace block instead of the single-repo format.
 */
export async function buildPromptPreamble(
  app: App,
  channel: string,
  threadTs: string,
  latestTs: string,
  botUserId?: string,
  workspace?: WorkspaceContext | null,
  worktreePaths?: Record<string, string>,
  repos?: RepoConfig[],
  contextProfile: AgentContextProfile = DEFAULT_CONTEXT_PROFILE,
): Promise<string> {
  // Only fetch the data we'll actually emit — skipping thread history matters
  // for lightweight task agents, both for tokens and for latency.
  const [persona, channelName, threadContext] = await Promise.all([
    contextProfile.identity ? loadPersona() : Promise.resolve(""),
    contextProfile.slack ? resolveChannelName(app, channel) : Promise.resolve(channel),
    contextProfile.threadHistory
      ? fetchThreadHistory(
          app,
          channel,
          threadTs,
          latestTs,
          botUserId,
          contextProfile.threadHistoryLimit,
        )
      : Promise.resolve(""),
  ]);

  const parts: string[] = [];

  if (contextProfile.identity) {
    parts.push(
      `<identity>`,
      persona,
      ``,
      `Your Slack user ID is ${botUserId ?? "unknown"}. Messages from this user ID in the thread are yours.`,
      `</identity>`,
      ``,
    );
  }

  if (contextProfile.slack) {
    parts.push(
      `<slack-context>`,
      `Channel: #${channelName} (${channel})`,
      `Thread: ${threadTs}`,
      `You are responding in this thread. You already have the full thread history below.`,
      `Do NOT use Slack search or read tools to find this thread — you already have all the context you need.`,
      `To tag a user, use their Slack mention format \`<@USERID>\` (shown in thread history as \`User(Name <@USERID>)\`). Plain \`@Name\` does not notify them.`,
      ``,
      `If you decide this message does NOT need a reply (e.g. it's noise, already handled, or you've finished silent work), your final response must be exactly the sentinel \`${NO_SLACK_MESSAGE}\` and nothing else — no surrounding text, no explanation, no quotes. Anything else will be posted to the channel verbatim.`,
      ``,
      `CRITICAL — no double-posting: if you used \`slack_send_message\` (or any other Slack post tool) during this turn, that tool call IS your reply. Your final response in this turn MUST be exactly \`${NO_SLACK_MESSAGE}\`. Do NOT also return a recap, summary, or "Posted X..." narration — the human already saw what you posted, and a second message restating it is a duplicate. Pick one channel: either post via the tool and return \`${NO_SLACK_MESSAGE}\`, or skip the tool and return prose as your reply. Never both.`,
      `</slack-context>`,
    );
  }

  if (contextProfile.workspace) {
    const workspaceBlock = buildWorkspaceBlock(workspace, worktreePaths, repos, threadTs);
    if (workspaceBlock) {
      parts.push(``, workspaceBlock);
    }
  }

  if (contextProfile.threadHistory && threadContext) {
    parts.push("", threadContext);
  }

  // Trim leading/trailing empty separators left by skipped blocks.
  return parts.join("\n").replace(/^\n+|\n+$/g, "");
}

async function fetchThreadHistory(
  app: App,
  channel: string,
  threadTs: string,
  latestTs: string,
  botUserId?: string,
  limit = DEFAULT_CONTEXT_PROFILE.threadHistoryLimit,
): Promise<string | null> {
  try {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      inclusive: true,
      limit,
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
      const role = m.isBot
        ? "Junior (you)"
        : `User(${m.userName}${m.user !== "unknown" ? ` <@${m.user}>` : ""})`;
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
