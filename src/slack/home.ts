import type { App } from "@slack/bolt";
import type { SessionStore } from "../session/store/interface.ts";
import type { ThreadSession } from "../session/types.ts";

export function registerHomeTab(app: App, store: SessionStore): void {
  app.event("app_home_opened", async ({ event }) => {
    await publishHomeTab(app, event.user, store);
  });
}

export async function publishHomeTab(
  app: App,
  userId: string,
  store: SessionStore,
): Promise<void> {
  const sessions = await store.getAll();
  const blocks = buildHomeBlocks(sessions);

  try {
    await app.client.views.publish({
      user_id: userId,
      view: {
        type: "home",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blocks: blocks as any,
      },
    });
  } catch (err) {
    console.error("[home] Failed to publish home tab:", err);
  }
}

function buildHomeBlocks(
  sessions: Map<string, ThreadSession>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "Junior", emoji: true },
  });

  // Stats summary
  const allSessions = Array.from(sessions.values());
  const active = allSessions.filter((s) => s.status === "busy").length;
  const idle = allSessions.filter((s) => s.status === "idle").length;
  const draining = allSessions.filter((s) => s.status === "draining").length;
  const withErrors = allSessions.filter((s) => s.lastError !== null).length;

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Active:* ${active}  |  *Idle:* ${idle}  |  *Draining:* ${draining}  |  *Errors:* ${withErrors}  |  *Total:* ${allSessions.length}`,
    },
  });

  blocks.push({ type: "divider" });

  // Active sessions
  const busySessions = allSessions.filter((s) => s.status !== "idle");
  if (busySessions.length > 0) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "Active Sessions" },
    });

    for (const session of busySessions) {
      blocks.push(sessionBlock(session));
    }
  }

  // Idle sessions (most recent first, limit 10)
  const idleSessions = allSessions
    .filter((s) => s.status === "idle")
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, 10);

  if (idleSessions.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "Recent Sessions" },
    });

    for (const session of idleSessions) {
      blocks.push(sessionBlock(session));
    }
  }

  // Recent errors
  const errorSessions = allSessions
    .filter((s) => s.lastError !== null)
    .sort((a, b) => (b.lastError?.timestamp ?? 0) - (a.lastError?.timestamp ?? 0))
    .slice(0, 5);

  if (errorSessions.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "Recent Errors" },
    });

    for (const session of errorSessions) {
      const ago = timeAgo(session.lastError!.timestamp);
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${session.threadId}*\n${session.lastError!.type}: ${session.lastError!.message}\n_${ago}_`,
        },
      });
    }
  }

  if (allSessions.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No active sessions._",
      },
    });
  }

  return blocks;
}

function sessionBlock(session: ThreadSession): Record<string, unknown> {
  const status =
    session.status === "busy"
      ? ":large_blue_circle: Busy"
      : session.status === "draining"
        ? ":hourglass: Draining"
        : ":white_circle: Idle";

  const agent = session.agentType ?? "default";
  const repo = session.targetRepo ?? "none";
  const ago = timeAgo(session.lastActivity);
  const pending = session.pendingMessages.length;

  let text = `*${session.threadId}*\n${status}  |  Agent: ${agent}  |  Repo: ${repo}\nLast activity: ${ago}`;

  if (pending > 0) {
    text += `  |  Pending: ${pending}`;
  }
  if (session.worktreePath) {
    text += `\nWorktree: \`${session.worktreePath}\``;
  }

  return {
    type: "section",
    text: { type: "mrkdwn", text },
  };
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
