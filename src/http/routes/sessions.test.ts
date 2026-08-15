import { describe, expect, it } from "bun:test";
import { InMemorySessionStore } from "../../session/store/memory.ts";
import { createSession } from "../../session/types.ts";
import type { NormalizedUsage } from "../../usage/normalize.ts";
import { InMemoryUsageStore } from "../../usage/store/memory.ts";
import { handleSessionDetail, handleSessions } from "./sessions.ts";

function seededSession() {
  const session = createSession("1712345678.123456", "C123");
  session.systemPrompt = "secret system prompt";
  session.pendingMessages = [{
    user: "U1",
    text: "pending body must not leak",
    ts: "1.1",
  }];
  session.activeTurnInput = {
    user: "U1",
    text: "live turn input must not leak",
    ts: "2.2",
  };
  session.activeTurnAuthor = "U1";
  session.cwd = "/tmp/cwd";
  session.worktreePath = "/tmp/wt";
  session.pid = 12345;
  session.lastError = {
    type: "spawn",
    message: "boom",
    timestamp: 1_700_000_000_000,
  };
  session.agentSessions = {
    review: {
      agentName: "review",
      sessionId: "ses-review",
      status: "idle",
      lastActivity: session.lastActivity,
      pendingMessages: [{
        user: "U1",
        text: "agent pending body",
        ts: "3.3",
      }],
      pid: 999,
      provider: "claude",
    },
  };
  return session;
}

function expectRedacted(payload: Record<string, unknown>) {
  const serialized = JSON.stringify(payload);
  expect(payload.systemPrompt).toBeUndefined();
  expect(payload.activeTurnInput).toBeUndefined();
  expect(payload.activeTurnAuthor).toBeUndefined();
  expect(payload.pid).toBeUndefined();
  expect(payload.cwd).toBeUndefined();
  expect(payload.worktreePath).toBeUndefined();
  expect(payload.worktreePaths).toBeUndefined();
  expect(payload.pendingMessages).toBe(1);
  expect(payload.lastError).toEqual({ type: "spawn", message: "boom" });
  expect(payload.spend).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    turns: 0,
  });
  const agents = payload.agents as Array<Record<string, unknown>>;
  expect(agents).toHaveLength(1);
  expect(agents[0]?.pid).toBeUndefined();
  expect(agents[0]?.pendingMessages).toBe(1);
  expect(serialized).not.toContain("secret system prompt");
  expect(serialized).not.toContain("pending body must not leak");
  expect(serialized).not.toContain("live turn input must not leak");
  expect(serialized).not.toContain("agent pending body");
}

describe("handleSessions", () => {
  it("allowlists list fields and hides pending bodies, prompts, and pids", async () => {
    const store = new InMemorySessionStore();
    const session = seededSession();
    await store.set(session.threadId, session);

    const response = await handleSessions(store);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(body.sessions).toHaveLength(1);
    expectRedacted(body.sessions[0]!);
    expect(body.sessions[0]!.resumeCwd).toBeUndefined();
    expect(body.sessions[0]!.slackPermalink).toBeUndefined();
    expect(body.sessions[0]!.hasWorktree).toBe(true);
  });

  it("summarizes spend from the requested threads only", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("1712345678.123456", "C123");
    await store.set(session.threadId, session);
    const usageStore = new InMemoryUsageStore();
    await usageStore.add(usageEvent({
      sourceId: `${session.threadId}:default:1`,
      threadId: session.threadId,
      inputTokens: 8,
      outputTokens: 3,
      costUsd: 0.02,
    }));
    await usageStore.add(usageEvent({
      sourceId: "other:default:1",
      threadId: "other-thread",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1,
    }));

    const response = await handleSessions(store, usageStore);
    const body = await response.json() as {
      sessions: Array<{ spend: Record<string, number> }>;
    };
    expect(body.sessions[0]!.spend).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      costUsd: 0.02,
      turns: 1,
    });
  });
});

describe("handleSessionDetail", () => {
  it("allowlists detail fields, adds resumeCwd, and zeros spend", async () => {
    const store = new InMemorySessionStore();
    const session = seededSession();
    await store.set(session.threadId, session);

    const response = await handleSessionDetail(store, session.threadId);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      session: Record<string, unknown>;
      slackPermalink: string | null;
    };
    expectRedacted(body.session);
    expect(body.session.resumeCwd).toBe("/tmp/wt");
    expect(body.session.slackPermalink).toBeNull();
    expect(body.slackPermalink).toBeNull();
  });

  it("includes the resolved Slack thread permalink", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("1712345678.123456", "C123");
    await store.set(session.threadId, session);

    const response = await handleSessionDetail(
      store,
      session.threadId,
      async (channel, messageTs) => {
        expect(channel).toBe("C123");
        expect(messageTs).toBe("1712345678.123456");
        return "https://example.slack.com/archives/C123/p1712345678123456";
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      slackPermalink: "https://example.slack.com/archives/C123/p1712345678123456",
      session: {
        slackPermalink: "https://example.slack.com/archives/C123/p1712345678123456",
      },
    });
  });

  it("keeps session detail available when Slack permalink resolution fails", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("1712345678.123456", "C123");
    await store.set(session.threadId, session);

    const response = await handleSessionDetail(
      store,
      session.threadId,
      async () => {
        throw new Error("Slack unavailable");
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session: { threadId: session.threadId },
      slackPermalink: null,
    });
  });
});

function usageEvent(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    sourceKind: "session-turn",
    sourceId: "thread-1:default:1",
    threadId: "thread-1",
    channelId: "C123",
    agentName: "default",
    provider: "opencode",
    providerSessionId: null,
    pipelineRunId: null,
    assignmentId: null,
    workflowName: null,
    workflowRunId: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 2,
    costUsd: null,
    costEstimatedUsd: null,
    numTurns: 1,
    raw: {},
    occurredAt: Date.now(),
    ...overrides,
  };
}
