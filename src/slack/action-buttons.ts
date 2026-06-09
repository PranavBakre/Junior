import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { SessionManager } from "../session/manager.ts";
import type { ThreadSession } from "../session/types.ts";
import { isPersistentAgent } from "../support/agents.ts";
import type { WorktreeManager, WorktreeStatus } from "../worktree/manager.ts";
import { log } from "../logger.ts";
import type { SlackActionRecord, SlackActionStore } from "./action-store.ts";

export const ACTION_BUTTON_ID = "junior_agent_action";

const ALLOWED_UNTRACKED_EXACT = new Set(["learnings.md", ".DS_Store"]);
const ALLOWED_UNTRACKED_PREFIXES = [".codex/", ".claude/"];

export function registerAgentActionButtons(
  app: App,
  actionStore: SlackActionStore,
  sessionManager: SessionManager,
  worktreeManager: WorktreeManager,
): void {
  app.action(ACTION_BUTTON_ID, async ({ ack, body, client }) => {
    await ack();

    const token = actionTokenFromBody(body);
    const userId = userIdFromBody(body);
    if (!token || !userId) return;

    const record = await actionStore.claim(token, userId);
    if (!record) {
      await postUnavailable(client, body);
      return;
    }

    await actionStore.disableMessageActions(record.channelId, record.messageTs);
    await removeMessageActions(client, record);

    try {
      if (record.action.type === "dispatch_agent") {
        await handleDispatch(record, userId, sessionManager);
      } else if (record.action.type === "cleanup_worktree") {
        await handleCleanup(record, sessionManager, worktreeManager, client);
      }
    } catch (err) {
      await actionStore.markFailed(record.token);
      await client.chat.postMessage({
        channel: record.channelId,
        thread_ts: record.threadTs,
        text: `Action failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

export async function disableAgentActionMessages(
  actionStore: SlackActionStore,
  client: WebClient,
  threadTs: string,
  sourceAgent: string,
  exceptMessageTs?: string,
): Promise<void> {
  const messages = await actionStore.disableSourceAgentActions(
    threadTs,
    sourceAgent,
    exceptMessageTs,
  );
  for (const message of messages) {
    await removeMessageActions(client, {
      channelId: message.channelId,
      messageTs: message.messageTs,
      messageText: message.messageText,
    });
  }
}

async function handleDispatch(
  record: SlackActionRecord,
  userId: string,
  sessionManager: SessionManager,
): Promise<void> {
  const action = record.action;
  if (action.type !== "dispatch_agent") return;
  if (!isPersistentAgent(action.agent) && action.agent !== "lead" && action.agent !== "default") {
    throw new Error(`unknown agent: ${action.agent}`);
  }

  await sessionManager.handleAgentMessage(
    {
      threadId: record.threadTs,
      channel: record.channelId,
      user: userId,
      text: action.prompt,
      ts: `${record.messageTs}:button:${record.actionId}`,
      command: null,
      dedupeKey: `button:${record.token}`,
    },
    action.agent,
  );
}

async function handleCleanup(
  record: SlackActionRecord,
  sessionManager: SessionManager,
  worktreeManager: WorktreeManager,
  client: WebClient,
): Promise<void> {
  const result = await cleanupThreadWorktrees(
    record.threadTs,
    sessionManager,
    worktreeManager,
  );
  await postThread(client, record, result);
}

export async function cleanupThreadWorktrees(
  threadTs: string,
  sessionManager: SessionManager,
  worktreeManager: WorktreeManager,
): Promise<string> {
  const session = await sessionManager.getSession(threadTs);
  if (!session) return "Cleanup skipped: thread session no longer exists.";
  const busy = session.status !== "idle" || Object.values(session.agentSessions ?? {}).some((agent) => agent.status === "busy");
  if (busy) {
    return "Cleanup skipped: an agent is still busy in this thread.";
  }

  const worktrees = registeredWorktrees(session);
  if (worktrees.length === 0) {
    return "Cleanup skipped: no registered worktree for this thread.";
  }

  const unsafe: string[] = [];
  for (const worktree of worktrees) {
    const status = await worktreeManager.getWorktreeStatus(worktree.path);
    const reason = unsafeCleanupReason(status);
    if (reason) unsafe.push(`${worktree.repo}: ${reason}`);
  }

  if (unsafe.length > 0) {
    return `Cleanup skipped:\n${unsafe.map((line) => `- ${line}`).join("\n")}`;
  }

  const removed: string[] = [];
  for (const worktree of worktrees) {
    await worktreeManager.removeWorktree(worktree.repo, session.threadId);
    removed.push(worktree.repo);
    if (session.worktreePaths?.[worktree.repo]) {
      delete session.worktreePaths[worktree.repo];
    }
    if (session.targetRepo === worktree.repo) {
      session.worktreePath = null;
      session.targetRepo = null;
    }
  }
  await sessionManager.updateSession(session.threadId, session);
  return `Cleaned up worktree${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}.`;
}

function registeredWorktrees(session: ThreadSession): Array<{ repo: string; path: string }> {
  const entries = Object.entries(session.worktreePaths ?? {}).filter(
    ([, path]) => !!path,
  );
  if (entries.length > 0) {
    return entries.map(([repo, path]) => ({ repo, path }));
  }
  if (session.targetRepo && session.worktreePath) {
    return [{ repo: session.targetRepo, path: session.worktreePath }];
  }
  return [];
}

function unsafeCleanupReason(status: WorktreeStatus): string | null {
  if (status.tracked.length > 0) {
    return `tracked changes present (${status.tracked.join(", ")})`;
  }
  const unsafeUntracked = status.untracked.filter((path) => !isAllowedUntracked(path));
  if (unsafeUntracked.length > 0) {
    return `unknown untracked files present (${unsafeUntracked.join(", ")})`;
  }
  return null;
}

function isAllowedUntracked(path: string): boolean {
  if (ALLOWED_UNTRACKED_EXACT.has(path)) return true;
  return ALLOWED_UNTRACKED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

async function removeMessageActions(
  client: WebClient,
  message: { channelId: string; messageTs: string; messageText: string },
): Promise<void> {
  if (!message.messageText) return;
  try {
    await client.chat.update({
      channel: message.channelId,
      ts: message.messageTs,
      text: message.messageText,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: message.messageText } }],
    });
  } catch (err) {
    log.error(
      "actions",
      `disable.fail channel=${message.channelId} ts=${message.messageTs} err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function postThread(
  client: WebClient,
  record: SlackActionRecord,
  text: string,
): Promise<void> {
  await client.chat.postMessage({
    channel: record.channelId,
    thread_ts: record.threadTs,
    text,
  });
}

async function postUnavailable(client: WebClient, body: unknown): Promise<void> {
  const channel = channelIdFromBody(body);
  const user = userIdFromBody(body);
  if (!channel || !user) return;
  try {
    await client.chat.postEphemeral({
      channel,
      user,
      text: "That action is no longer available.",
    });
  } catch {
    // Best-effort UX only.
  }
}

function actionTokenFromBody(body: unknown): string | null {
  const action = firstAction(body);
  return typeof action?.value === "string" ? action.value : null;
}

function firstAction(body: unknown): { value?: unknown } | null {
  if (!isRecord(body) || !Array.isArray(body.actions)) return null;
  const [action] = body.actions;
  return isRecord(action) ? action : null;
}

function userIdFromBody(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.user)) return null;
  return typeof body.user.id === "string" ? body.user.id : null;
}

function channelIdFromBody(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.channel) && typeof body.channel.id === "string") {
    return body.channel.id;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
