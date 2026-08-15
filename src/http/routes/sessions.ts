import type { Config } from "../../config.ts";
import type { DashboardAuditStore } from "../audit/interface.ts";
import { log } from "../../logger.ts";
import { resolveContinueRoute } from "../../session/continue-route.ts";
import {
  formatStopReply,
  type SessionManager,
} from "../../session/manager.ts";
import type { SessionStore } from "../../session/store/interface.ts";
import type { AgentSession, ThreadSession } from "../../session/types.ts";
import type { UsageStore } from "../../usage/store/interface.ts";

export const CONTINUE_PROMPT_MAX = 8000;

const SLACK_ID_RE = /^[UWB][A-Z0-9]+$/;

export type SlackPoster = {
  post: (channel: string, threadTs: string, text: string) => Promise<{ ts: string } | null>;
  react: (channel: string, ts: string, emoji: string) => Promise<void>;
};

export function dashboardActor(config: Config): string {
  return config.adminSlackUserId ?? "dashboard-operator";
}

export function formatDashboardContinueSlackBody(
  actor: string,
  prompt: string,
): string {
  const who = SLACK_ID_RE.test(actor) ? `<@${actor}>` : "`dashboard-operator`";
  const preview = prompt.replace(/\r\n/g, " · ").replace(/[\r\n]/g, " · ").slice(0, 240);
  return `*Dashboard continue* · local operator · ${who}\n> ${preview}`;
}

export type SlackPermalinkResolver = (
  channel: string,
  messageTs: string,
) => Promise<string | null>;

export type SessionSpendSummary = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
};

const EMPTY_SPEND: SessionSpendSummary = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  turns: 0,
};

export async function handleSessions(
  store: SessionStore,
  usageStore?: UsageStore,
): Promise<Response> {
  const allSessions = await store.getAll();
  const sorted = [...allSessions.values()].sort(
    (a, b) => b.lastActivity - a.lastActivity,
  );
  const spendByThread = await spendByThreadId(
    usageStore,
    sorted.map((session) => session.threadId),
  );
  const sessions = sorted.map((session) =>
    projectSession(session, {
      spend: spendByThread.get(session.threadId) ?? EMPTY_SPEND,
    }),
  );

  return Response.json({ sessions });
}

export async function handleSessionDetail(
  store: SessionStore,
  threadId: string,
  resolveSlackPermalink?: SlackPermalinkResolver,
  usageStore?: UsageStore,
): Promise<Response> {
  const session = await store.get(threadId);
  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  let slackPermalink: string | null = null;
  if (resolveSlackPermalink) {
    try {
      slackPermalink = await resolveSlackPermalink(session.channel, session.threadId);
    } catch {
      // Slack navigation is an enhancement to the read-only detail view. A
      // transient Slack API failure must not make the session itself unreadable.
    }
  }

  const spendByThread = await spendByThreadId(usageStore, [session.threadId]);
  const projected = projectSession(session, {
    detail: true,
    slackPermalink,
    spend: spendByThread.get(session.threadId) ?? EMPTY_SPEND,
  });

  return Response.json({ session: projected, slackPermalink });
}

function projectSession(
  session: ThreadSession,
  options: {
    detail?: boolean;
    slackPermalink?: string | null;
    spend: SessionSpendSummary;
  },
) {
  const projected: Record<string, unknown> = {
    threadId: session.threadId,
    channel: session.channel,
    provider: session.provider ?? null,
    sessionId: session.sessionId,
    leadSessionId: session.leadSessionId,
    status: session.status,
    agentType: session.agentType,
    defaultAgent: session.defaultAgent ?? null,
    activeAgentName: session.activeAgentName ?? null,
    targetRepo: session.targetRepo,
    baseRef: session.baseRef,
    muted: session.muted,
    dormant: session.dormant,
    verbosity: session.verbosity,
    driverMode: session.driverMode,
    lastActivity: session.lastActivity,
    createdAt: session.createdAt,
    lastError: projectLastError(session.lastError),
    pendingMessages: session.pendingMessages.length,
    hasWorktree: Boolean(
      session.worktreePath || Object.keys(session.worktreePaths ?? {}).length,
    ),
    agents: projectAgents(session.agentSessions, session.provider),
    spend: options.spend,
  };
  if (options.detail) {
    projected.resumeCwd = session.worktreePath || session.cwd || null;
    projected.slackPermalink = options.slackPermalink ?? null;
  }
  return projected;
}

function projectLastError(error: ThreadSession["lastError"]) {
  if (!error) return null;
  return { type: error.type, message: error.message };
}

function projectAgents(
  agentSessions: Record<string, AgentSession> | undefined,
  fallbackProvider: ThreadSession["provider"],
) {
  return Object.values(agentSessions ?? {})
    .map((agent) => ({
      agentName: agent.agentName,
      sessionId: agent.sessionId,
      status: agent.status,
      lastActivity: agent.lastActivity,
      pendingMessages: agent.pendingMessages.length,
      provider: agent.provider ?? fallbackProvider ?? null,
    }))
    .sort((a, b) => a.agentName.localeCompare(b.agentName));
}

async function spendByThreadId(
  usageStore: UsageStore | undefined,
  threadIds: string[],
): Promise<Map<string, SessionSpendSummary>> {
  const result = new Map<string, SessionSpendSummary>();
  for (const threadId of threadIds) result.set(threadId, EMPTY_SPEND);
  if (!usageStore || threadIds.length === 0) return result;

  const buckets = await usageStore.summarizeByThread(threadIds);
  for (const bucket of buckets) {
    result.set(bucket.key, {
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      costUsd: bucket.costUsd,
      turns: bucket.turns,
    });
  }
  return result;
}

export async function handleSessionContinue(
  req: Request,
  threadId: string,
  deps: {
    sessionManager: Pick<
      SessionManager,
      "injectDashboardContinue" | "getSession"
    >;
    slackPoster: SlackPoster;
    auditStore: DashboardAuditStore;
    config: Config;
  },
): Promise<Response> {
  const actor = dashboardActor(deps.config);
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request: {},
      result: "error",
      error: parsed.error,
    });
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const prompt = parsed.value.prompt;
  const agentName = parsed.value.agentName;
  const request = {
    prompt: typeof prompt === "string" ? prompt : prompt ?? null,
    agentName: agentName ?? null,
  };

  if (typeof prompt !== "string" || prompt.trim() === "") {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "error",
      error: "invalid prompt",
    });
    return Response.json({ error: "invalid prompt" }, { status: 400 });
  }
  if (prompt.length > CONTINUE_PROMPT_MAX) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "error",
      error: "prompt too long",
    });
    return Response.json({ error: "prompt too long" }, { status: 400 });
  }
  if (agentName !== undefined && typeof agentName !== "string") {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "error",
      error: "unknown-agent",
    });
    return Response.json({ error: "unknown-agent" }, { status: 400 });
  }

  const session = await deps.sessionManager.getSession(threadId);
  if (!session) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "error",
      error: "session not found",
    });
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  if (!session.channel || !session.threadId) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "error",
      error: "session has no channel",
    });
    return Response.json({ error: "session has no channel" }, { status: 400 });
  }

  const route = resolveContinueRoute(agentName, session);
  if ("error" in route) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "error",
      error: "unknown-agent",
    });
    return Response.json({ error: "unknown-agent" }, { status: 400 });
  }

  if (session.muted) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "denied",
      error: "session muted",
    });
    return Response.json({ error: "session muted" }, { status: 409 });
  }

  const posted = await deps.slackPoster.post(
    session.channel,
    session.threadId,
    formatDashboardContinueSlackBody(actor, prompt),
  );
  if (!posted?.ts) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "error",
      error: "slack post failed",
    });
    return Response.json({ error: "slack post failed" }, { status: 502 });
  }

  const injected = await deps.sessionManager.injectDashboardContinue({
    threadId: session.threadId,
    channel: session.channel,
    prompt,
    agentName,
    actorSlackUserId: actor,
    postedTs: posted.ts,
  });

  if (injected.status === "muted") {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.continue",
      targetId: threadId,
      request,
      result: "denied",
      error: "session muted",
      slackTs: posted.ts,
    });
    return Response.json({ error: "session muted" }, { status: 409 });
  }

  log.info(
    "dashboard",
    `action=session.continue thread=${threadId} result=${injected.status}`,
  );
  await recordSessionAudit(deps.auditStore, {
    actor,
    action: "session.continue",
    targetId: threadId,
    request,
    result: injected.status === "buffered" ? "buffered" : "ok",
    slackTs: posted.ts,
  });
  return Response.json({ status: injected.status }, { status: 202 });
}

export async function handleSessionStop(
  threadId: string,
  deps: {
    sessionManager: Pick<SessionManager, "interruptThread" | "getSession">;
    slackPoster: SlackPoster;
    auditStore: DashboardAuditStore;
    config: Config;
  },
): Promise<Response> {
  const actor = dashboardActor(deps.config);
  const session = await deps.sessionManager.getSession(threadId);
  if (!session) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.stop",
      targetId: threadId,
      result: "error",
      error: "session not found",
    });
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  if (!session.channel || !session.threadId) {
    await recordSessionAudit(deps.auditStore, {
      actor,
      action: "session.stop",
      targetId: threadId,
      result: "error",
      error: "session has no channel",
    });
    return Response.json({ error: "session has no channel" }, { status: 400 });
  }

  const interrupted = await deps.sessionManager.interruptThread(session.threadId);
  const message = formatStopReply(interrupted);
  const posted = await deps.slackPoster.post(
    session.channel,
    session.threadId,
    message,
  );

  log.info(
    "dashboard",
    `action=session.stop thread=${threadId} result=ok interrupted=${interrupted}`,
  );
  await recordSessionAudit(deps.auditStore, {
    actor,
    action: "session.stop",
    targetId: threadId,
    result: posted?.ts ? "ok" : "partial",
    error: posted?.ts ? null : "slack post failed",
    slackTs: posted?.ts ?? null,
  });
  return Response.json({ status: "ok", interrupted, message });
}

async function readJsonBody(
  req: Request,
): Promise<
  | { ok: true; value: { prompt?: unknown; agentName?: unknown } }
  | { ok: false; error: string }
> {
  const text = await req.text();
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as { prompt?: unknown; agentName?: unknown };
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "invalid json" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: "invalid json" };
  }
}

async function recordSessionAudit(
  store: DashboardAuditStore,
  entry: {
    actor: string;
    action: string;
    targetId: string;
    request?: Record<string, unknown>;
    result: string;
    error?: string | null;
    slackTs?: string | null;
  },
): Promise<void> {
  await store.record({
    actor: entry.actor,
    action: entry.action,
    targetType: "session",
    targetId: entry.targetId,
    request: entry.request ?? {},
    result: entry.result,
    error: entry.error ?? null,
    slackTs: entry.slackTs ?? null,
  });
}
