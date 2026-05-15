import type { App } from "@slack/bolt";
import type { SessionStore } from "../session/store/interface.ts";
import type { ThreadSession } from "../session/types.ts";

export function registerHomeTab(
  app: App,
  store: SessionStore,
  windowMs: number,
): void {
  app.event("app_home_opened", async ({ event }) => {
    await publishHomeTab(app, event.user, store, windowMs);
  });
}

export async function publishHomeTab(
  app: App,
  userId: string,
  store: SessionStore,
  windowMs: number,
): Promise<void> {
  const sessions = await store.getRecent(windowMs);
  const permalinks = await resolvePermalinks(app, sessions);
  const blocks = buildHomeBlocks(sessions, permalinks);

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

async function resolvePermalinks(
  app: App,
  sessions: Map<string, ThreadSession>,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    Array.from(sessions.values()).map(async (s) => {
      try {
        const res = await app.client.chat.getPermalink({
          channel: s.channel,
          message_ts: s.threadId,
        });
        return [s.threadId, res.permalink ?? ""] as const;
      } catch {
        return [s.threadId, ""] as const;
      }
    }),
  );
  return new Map(entries.filter(([, url]) => url !== ""));
}

function buildHomeBlocks(
  sessions: Map<string, ThreadSession>,
  permalinks: Map<string, string>,
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
  const muted = allSessions.filter((s) => s.muted).length;

  const summaryParts = [
    `*Active:* ${active}`,
    `*Idle:* ${idle}`,
    `*Draining:* ${draining}`,
    `*Errors:* ${withErrors}`,
    ...(muted > 0 ? [`*Muted:* ${muted}`] : []),
    `*Total:* ${allSessions.length}`,
  ];

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: summaryParts.join("  |  ") },
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
      blocks.push(sessionBlock(session, permalinks.get(session.threadId)));
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
      blocks.push(sessionBlock(session, permalinks.get(session.threadId)));
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
      const url = permalinks.get(session.threadId);
      const title = url
        ? `<${url}|*${session.threadId}*>`
        : `*${session.threadId}*`;
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${title}\n${session.lastError!.type}: ${session.lastError!.message}\n_${ago}_`,
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

function sessionBlock(
  session: ThreadSession,
  permalink: string | undefined,
): Record<string, unknown> {
  const status =
    session.status === "busy"
      ? ":large_blue_circle: Busy"
      : session.status === "draining"
        ? ":hourglass: Draining"
        : ":white_circle: Idle";

  const leadAgent = session.agentType ?? "default";
  const provider = session.provider ?? "claude";
  const repo = session.targetRepo ?? "none";
  const ago = timeAgo(session.lastActivity);
  const pending = session.pendingMessages.length;

  const title = permalink
    ? `<${permalink}|*${session.threadId}*>`
    : `*${session.threadId}*`;

  // Lead/primary session line
  const muteFlag = session.muted ? "  |  :no_bell: *Muted*" : "";
  let text = `${title}\n${status}${muteFlag}  |  Agent: \`${leadAgent}\`  |  Provider: \`${provider}\`  |  Repo: ${repo}\nLast activity: ${ago}`;

  if (pending > 0) {
    text += `  |  Pending: ${pending}`;
  }
  if (session.worktreePath) {
    text += `\nWorktree: \`${session.worktreePath}\``;
  }
  if (session.sessionId) {
    text += `\nResume: \`${resumeCommand(provider, session.sessionId)}\``;
  }

  // Persistent agent sub-sessions (multi-agent threads — bug pipeline, etc.)
  const agentEntries = Object.values(session.agentSessions ?? {}).filter(
    (a) => a.sessionId !== null,
  );
  if (agentEntries.length > 0) {
    const agentLines = agentEntries
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((a) => {
        const agentStatus =
          a.status === "busy"
            ? ":large_blue_circle:"
            : a.status === "failed"
              ? ":x:"
              : a.status === "done"
                ? ":white_check_mark:"
                : ":white_circle:";
        const agentPending = a.pendingMessages?.length ?? 0;
        const agentAgo = timeAgo(a.lastActivity);
        let line = `  ${agentStatus} \`${a.agentName}\` — ${a.status}, last ${agentAgo}`;
        if (agentPending > 0) line += `, pending ${agentPending}`;
        if (a.sessionId) line += `\n     Resume: \`${resumeCommand(a.provider ?? provider, a.sessionId)}\``;
        return line;
      })
      .join("\n");
    text += `\n_Agents in this thread:_\n${agentLines}`;
  }

  return {
    type: "section",
    text: { type: "mrkdwn", text },
  };
}

function resumeCommand(provider: string, sessionId: string): string {
  switch (provider) {
    case "opencode":
      return `opencode --session ${sessionId}`;
    case "codex":
      return `codex exec resume ${sessionId}`;
    case "claude":
    default:
      return `claude --resume ${sessionId}`;
  }
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
