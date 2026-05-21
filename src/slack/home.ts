import type { App } from "@slack/bolt";
import type { KnownBlock, View } from "@slack/types";
import type { SessionStore } from "../session/store/interface.ts";
import type { ThreadSession } from "../session/types.ts";
import type { WorkflowRun, WorkflowState } from "../workflows/types.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import { sanitizeErrorForSlack } from "./formatting.ts";

const HOME_TEXT_LIMIT = 2_900;
const MODAL_TEXT_LIMIT = 2_900;
const ACTION_SESSION_DETAILS = "home_session_details";

export function registerHomeTab(
  app: App,
  store: SessionStore,
  windowMs: number,
  workflowStore?: WorkflowStore,
): void {
  app.event("app_home_opened", async ({ event }) => {
    await publishHomeTab(app, event.user, store, windowMs, workflowStore);
  });

  app.action(ACTION_SESSION_DETAILS, async ({ ack, body, client }) => {
    await ack();

    const action = firstAction(body);
    const threadId = typeof action?.value === "string" ? action.value : null;
    const triggerId = triggerIdFromBody(body);
    if (!threadId || !triggerId) return;

    const session = await store.get(threadId);
    if (!session) return;

    await client.views.open({
      trigger_id: triggerId,
      view: buildSessionDetailModal(session),
    });
  });
}

export async function publishHomeTab(
  app: App,
  userId: string,
  store: SessionStore,
  windowMs: number,
  workflowStore?: WorkflowStore,
): Promise<void> {
  const sessions = await store.getRecent(windowMs);
  const workflowData = workflowStore
    ? await loadWorkflowHomeData(workflowStore)
    : { states: [], runsByWorkflow: new Map<string, WorkflowRun[]>() };
  const permalinks = await resolvePermalinks(app, sessions);
  const blocks = buildHomeBlocks(sessions, permalinks, workflowData);

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
  workflowData: {
    states: WorkflowState[];
    runsByWorkflow: Map<string, WorkflowRun[]>;
  },
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

  if (workflowData.states.length > 0) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "Workflows" },
    });

    for (const state of workflowData.states) {
      blocks.push(workflowBlock(state, workflowData.runsByWorkflow.get(state.name) ?? []));
    }
  }

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
          text: truncateMrkdwn(
            `${title}\n${formatLastErrorForSlack(session.lastError!)}\n_${ago}_`,
            HOME_TEXT_LIMIT,
          ),
        },
      });
    }
  }

  if (allSessions.length === 0 && workflowData.states.length === 0) {
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

async function loadWorkflowHomeData(
  workflowStore: WorkflowStore,
): Promise<{
  states: WorkflowState[];
  runsByWorkflow: Map<string, WorkflowRun[]>;
}> {
  const states = await workflowStore.listStates();
  const runsByWorkflow = new Map<string, WorkflowRun[]>();
  await Promise.all(
    states.map(async (state) => {
      runsByWorkflow.set(state.name, await workflowStore.listRuns(state.name, 3));
    }),
  );
  return { states, runsByWorkflow };
}

function workflowBlock(
  state: WorkflowState,
  runs: WorkflowRun[],
): Record<string, unknown> {
  const status = workflowStatusLabel(state.status);
  const nextRun = state.nextRunAt ? new Date(state.nextRunAt).toISOString() : "none";
  const lastRun = state.lastRunAt ? `${state.lastRunStatus ?? "unknown"} ${timeAgo(state.lastRunAt)}` : "never";
  const latest = runs[0];
  const latestArtifact = latest ? `\nLatest artifact: \`${latest.artifactPath}\`` : "";
  const latestSession = latest?.providerSessionId
    ? `\nProvider session: \`${latest.providerSessionId}\``
    : "";
  const error = state.lastError ? `\nLast error: ${sanitizeErrorForSlack(state.lastError)}` : "";

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateMrkdwn(
        `*${state.name}*\n${status}  |  Next: ${nextRun}  |  Last: ${lastRun}${latestArtifact}${latestSession}${error}`,
        HOME_TEXT_LIMIT,
      ),
    },
  };
}

function workflowStatusLabel(status: WorkflowState["status"]): string {
  switch (status) {
    case "active":
      return ":large_green_circle: Active";
    case "stopped":
      return ":white_circle: Stopped";
    case "invalid":
      return ":red_circle: Invalid";
  }
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

  const muteFlag = session.muted ? "  |  :no_bell: *Muted*" : "";
  let text = `${title}\n${status}${muteFlag}  |  Agent: \`${leadAgent}\`  |  Provider: \`${provider}\`  |  Repo: ${repo}\nLast activity: ${ago}`;

  if (pending > 0) {
    text += `  |  Pending: ${pending}`;
  }
  const agentEntries = Object.values(session.agentSessions ?? {}).filter(
    (a) => a.sessionId !== null,
  );
  if (agentEntries.length > 0) {
    const busyAgents = agentEntries.filter((a) => a.status === "busy").length;
    text += `  |  Agents: ${agentEntries.length}`;
    if (busyAgents > 0) text += ` (${busyAgents} busy)`;
  }

  return {
    type: "section",
    text: { type: "mrkdwn", text: truncateMrkdwn(text, HOME_TEXT_LIMIT) },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "View details", emoji: true },
      action_id: ACTION_SESSION_DETAILS,
      value: session.threadId,
    },
  };
}

export function buildSessionDetailModal(session: ThreadSession): View {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Session details" },
    close: { type: "plain_text", text: "Close" },
    blocks: buildSessionDetailBlocks(session),
  };
}

function buildSessionDetailBlocks(session: ThreadSession): KnownBlock[] {
  const chunks = splitMrkdwn(buildSessionDetailText(session), MODAL_TEXT_LIMIT);
  return chunks.map((text) => ({
    type: "section",
    text: { type: "mrkdwn", text },
  }));
}

function buildSessionDetailText(session: ThreadSession): string {
  const provider = session.provider ?? "claude";
  const fields = [
    `*Session*\n\`${session.threadId}\``,
    `*Status:* ${session.status}`,
    `*Agent:* \`${session.agentType ?? "default"}\``,
    `*Provider:* \`${provider}\``,
    `*Repo:* ${session.targetRepo ?? "none"}`,
    `*Last activity:* ${timeAgo(session.lastActivity)}`,
    `*Muted:* ${session.muted ? "yes" : "no"}`,
    `*Pending messages:* ${session.pendingMessages.length}`,
  ];

  if (session.worktreePath) fields.push(`*Worktree:*\n\`${session.worktreePath}\``);
  if (session.sessionId) fields.push(`*Resume:*\n\`${resumeCommand(provider, session.sessionId)}\``);

  const agentEntries = Object.values(session.agentSessions ?? {})
    .filter((a) => a.sessionId !== null)
    .sort((a, b) => b.lastActivity - a.lastActivity);
  if (agentEntries.length > 0) {
    const agentLines = agentEntries.map((a) => {
      const agentPending = a.pendingMessages?.length ?? 0;
      const agentProvider = a.provider ?? provider;
      let firstLine = `• \`${a.agentName}\` — ${a.status}, last ${timeAgo(a.lastActivity)}`;
      if (agentPending > 0) firstLine += `, pending ${agentPending}`;
      const lines = [firstLine];
      if (a.sessionId) lines.push(`  Resume: \`${resumeCommand(agentProvider, a.sessionId)}\``);
      return lines.join("\n");
    });
    fields.push(`*Agents in this thread:*\n${agentLines.join("\n\n")}`);
  }

  if (session.lastError) {
    fields.push(`*Last error:*\n${formatLastErrorForSlack(session.lastError)}\n_${timeAgo(session.lastError.timestamp)}_`);
  }

  return fields.join("\n\n");
}

function formatLastErrorForSlack(error: { type: string; message: string }): string {
  return sanitizeErrorForSlack(`${error.type}: ${error.message}`);
}

function truncateMrkdwn(text: string, max: number): string {
  if (text.length <= max) return text;
  const suffix = "\n… _truncated_";
  return `${text.slice(0, max - suffix.length)}${suffix}`;
}

function splitMrkdwn(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf("\n\n", max);
    if (splitAt < Math.floor(max / 2)) splitAt = max;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.slice(0, 100);
}

function firstAction(body: unknown): { value?: unknown } | undefined {
  const actions = (body as { actions?: Array<{ value?: unknown }> })?.actions;
  return Array.isArray(actions) ? actions[0] : undefined;
}

function triggerIdFromBody(body: unknown): string | null {
  const triggerId = (body as { trigger_id?: unknown })?.trigger_id;
  return typeof triggerId === "string" ? triggerId : null;
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
