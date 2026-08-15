import type { SessionStore } from "../../session/store/interface.ts";
import type { AgentSession, ThreadSession } from "../../session/types.ts";
import type { UsageStore } from "../../usage/store/interface.ts";

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
