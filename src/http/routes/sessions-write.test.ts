import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Config } from "../../config.ts";
import type {
  SpawnHandle,
  SpawnResult,
  SpawnRunnerFn,
} from "../../runners/types.ts";
import { SessionManager } from "../../session/manager.ts";
import { InMemorySessionStore } from "../../session/store/memory.ts";
import { createSession } from "../../session/types.ts";
import { InMemoryPipelineStore } from "../../pipelines/store/memory.ts";
import { InMemoryDashboardAuditStore } from "../audit/memory.ts";
import { InMemoryUsageStore } from "../../usage/store/memory.ts";
import { startHttpServer, type HttpServerDeps } from "../server.ts";
import {
  formatDashboardContinueSlackBody,
} from "./sessions.ts";

const THREAD_ID = "1712345678.123456";
const CHANNEL = "C123";

describe("session continue/stop writes", () => {
  let store: InMemorySessionStore;
  let manager: SessionManager;
  let auditStore: InMemoryDashboardAuditStore;
  let slackPosts: Array<{ channel: string; threadTs: string; text: string }>;
  let slackPostResult: { ts: string } | null;
  let spawn: ReturnType<typeof mock<SpawnRunnerFn>>;
  let lastHandle: SpawnHandle;
  let server: ReturnType<typeof startHttpServer> | undefined;
  let config: Config;

  beforeEach(async () => {
    store = new InMemorySessionStore();
    auditStore = new InMemoryDashboardAuditStore();
    slackPosts = [];
    slackPostResult = { ts: "1712345678.999001" };
    lastHandle = createHandle();
    spawn = mock<SpawnRunnerFn>((() => lastHandle) as SpawnRunnerFn);
    config = testConfig();
    manager = new SessionManager(store, config, spawn);
    await store.set(THREAD_ID, createSession(THREAD_ID, CHANNEL));
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  it("continues an idle session with 202 accepted", async () => {
    const res = await continueRequest({ prompt: "please continue" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(slackPosts).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((spawn.mock.calls[0] as unknown[])[1]).toBe("please continue");
    const audit = await auditStore.list({ action: "session.continue" });
    expect(audit[0]).toMatchObject({
      result: "ok",
      slackTs: "1712345678.999001",
    });
  });

  it("returns 202 buffered from injectDashboardContinue when the agent is busy", async () => {
    await manager.handleMessage({
      threadId: THREAD_ID,
      channel: CHANNEL,
      user: "UADMIN01",
      text: "start the task",
      ts: "1.1",
      command: null,
    });
    expect(spawn).toHaveBeenCalledTimes(1);

    const res = await continueRequest({ prompt: "follow up" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "buffered" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(slackPosts).toHaveLength(1);
    const session = await store.get(THREAD_ID);
    expect(session?.pendingMessages.map((m) => m.text)).toEqual(["follow up"]);
    const audit = await auditStore.list({ action: "session.continue" });
    expect(audit[0]?.result).toBe("buffered");
  });

  it("returns 409 for a muted session and does not post to Slack", async () => {
    await store.mutateThread(THREAD_ID, (s) => {
      s.muted = true;
    });
    const res = await continueRequest({ prompt: "hello" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "session muted" });
    expect(slackPosts).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    const audit = await auditStore.list({ action: "session.continue" });
    expect(audit[0]).toMatchObject({ result: "denied", error: "session muted" });
  });

  it("returns 502 when Slack post fails and does not inject", async () => {
    slackPostResult = null;
    const res = await continueRequest({ prompt: "hello" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "slack post failed" });
    expect(spawn).not.toHaveBeenCalled();
    expect((await store.get(THREAD_ID))?.status).toBe("idle");
    const audit = await auditStore.list({ action: "session.continue" });
    expect(audit[0]).toMatchObject({ result: "error", error: "slack post failed" });
  });

  it("returns 400 for an unknown or not-on-thread agent before Slack post", async () => {
    const unknown = await continueRequest({ prompt: "hello", agentName: "review" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "unknown-agent" });
    expect(slackPosts).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();

    const missing = await continueRequest({ prompt: "hello" }, "missing-thread");
    expect(missing.status).toBe(404);
    expect(slackPosts).toHaveLength(0);
  });

  it('routes defaultAgent "junior" to handleMessage and never handleAgentMessage', async () => {
    await store.mutateThread(THREAD_ID, (s) => {
      s.defaultAgent = "junior";
    });
    const agentCalls: string[] = [];
    const origAgent = manager.handleAgentMessage.bind(manager);
    manager.handleAgentMessage = async (event, agentName) => {
      agentCalls.push(agentName);
      return origAgent(event, agentName);
    };

    const res = await continueRequest({ prompt: "keep going" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(agentCalls).toEqual([]);
    expect((await store.get(THREAD_ID))?.agentSessions?.junior).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("quotes a !review prompt on Slack and injects exactly once", async () => {
    const injectCalls: unknown[] = [];
    const origInject = manager.injectDashboardContinue.bind(manager);
    manager.injectDashboardContinue = async (input) => {
      injectCalls.push(input);
      return origInject(input);
    };
    const agentCalls: string[] = [];
    const origAgent = manager.handleAgentMessage.bind(manager);
    manager.handleAgentMessage = async (event, agentName) => {
      agentCalls.push(agentName);
      return origAgent(event, agentName);
    };

    const prompt = "!review please inspect this\nand another line";
    const res = await continueRequest({ prompt });
    expect(res.status).toBe(202);
    expect(slackPosts).toHaveLength(1);
    const body = slackPosts[0]!.text;
    expect(body.startsWith("*Dashboard continue*")).toBe(true);
    expect(body).toBe(formatDashboardContinueSlackBody("UADMIN01", prompt));
    for (const line of body.split("\n")) {
      expect(line.match(/^!(\S+)/)).toBeNull();
    }
    expect(body).toContain("> ");
    expect(injectCalls).toHaveLength(1);
    expect(agentCalls).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not hijack an active pipeline run via routeDirectTaskThroughDefaultRun", async () => {
    const pipelineStore = new InMemoryPipelineStore();
    config = testConfig({
      pipeline: {
        runtimeMode: "active",
        legacyDirectivesEnabled: true,
        bugPipelineEnabled: true,
        productPipelineEnabled: true,
        retentionDays: 90,
      },
    });
    manager = new SessionManager(store, config, spawn);
    manager.pipelineStore = pipelineStore;

    await manager.handleMessage({
      threadId: THREAD_ID,
      channel: CHANNEL,
      user: "UADMIN01",
      text: "start the task",
      ts: "1.1",
      command: null,
    });
    const beforeAssignments = (await pipelineStore.getRunByThread(THREAD_ID))
      ? await pipelineStore.listAssignments(
        (await pipelineStore.getRunByThread(THREAD_ID))!.id,
      )
      : [];

    const res = await continueRequest({ prompt: "dashboard follow-up" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "buffered" });
    const session = await store.get(THREAD_ID);
    expect(session?.pendingMessages.map((m) => m.text)).toEqual(["dashboard follow-up"]);
    expect(session?.pendingMessages[0]?.text).not.toContain("[task-follow-up]");
    const run = await pipelineStore.getRunByThread(THREAD_ID);
    const afterAssignments = run ? await pipelineStore.listAssignments(run.id) : [];
    expect(afterAssignments).toHaveLength(beforeAssignments.length);
    expect(
      afterAssignments.some((a) => a.contextRefs.includes("control-branch:human-input")),
    ).toBe(false);
  });

  it("buffers a dashboard continue when short-followup interrupt is enabled", async () => {
    config = testConfig({
      session: {
        ...testConfig().session,
        shortFollowupInterruptEnabled: true,
        shortFollowupMaxLength: 240,
      },
    });
    lastHandle = createHandle();
    const kill = lastHandle.kill as ReturnType<typeof mock>;
    manager = new SessionManager(store, config, spawn);

    await manager.handleMessage({
      threadId: THREAD_ID,
      channel: CHANNEL,
      user: "UADMIN01",
      text: "start the task",
      ts: "1.1",
      command: null,
    });

    const res = await continueRequest({ prompt: "small correction" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "buffered" });
    expect(kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((await store.get(THREAD_ID))?.pendingMessages[0]?.text).toBe("small correction");
  });

  it("stop calls interruptThread and posts the !stop Slack line", async () => {
    await manager.handleMessage({
      threadId: THREAD_ID,
      channel: CHANNEL,
      user: "UADMIN01",
      text: "go",
      ts: "1.1",
      command: null,
    });
    expect((await store.get(THREAD_ID))?.status).toBe("busy");

    const res = await stopRequest();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      interrupted: 1,
      message: "Interrupted (1 agent). Send a new message to continue.",
    });
    expect(lastHandle.kill).toHaveBeenCalled();
    expect(slackPosts).toEqual([{
      channel: CHANNEL,
      threadTs: THREAD_ID,
      text: "Interrupted (1 agent). Send a new message to continue.",
    }]);
    expect((await store.get(THREAD_ID))?.status).toBe("idle");
    const audit = await auditStore.list({ action: "session.stop" });
    expect(audit[0]).toMatchObject({
      result: "ok",
      slackTs: "1712345678.999001",
    });
  });

  it("returns 405 on POST /api/sessions/:id", async () => {
    const res = await request("POST", `/api/sessions/${THREAD_ID}`);
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method not allowed" });
    expect(slackPosts).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  async function continueRequest(
    body: { prompt: string; agentName?: string },
    threadId = THREAD_ID,
  ) {
    return request("POST", `/api/sessions/${threadId}/continue`, body);
  }

  async function stopRequest(threadId = THREAD_ID) {
    return request("POST", `/api/sessions/${threadId}/stop`);
  }

  async function request(method: string, path: string, body?: unknown) {
    ensureServer();
    return fetch(`http://127.0.0.1:${server!.port}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function ensureServer() {
    if (server) return;
    server = startHttpServer(deps());
  }

  function deps(): HttpServerDeps {
    return {
      store,
      config,
      devServerManager: {} as HttpServerDeps["devServerManager"],
      devServerQueue: {} as HttpServerDeps["devServerQueue"],
      repos: [],
      workflowRegistry: {} as HttpServerDeps["workflowRegistry"],
      workflowScheduler: {} as HttpServerDeps["workflowScheduler"],
      workflowStore: {} as HttpServerDeps["workflowStore"],
      pipelineStore: {} as HttpServerDeps["pipelineStore"],
      usageStore: new InMemoryUsageStore(),
      auditStore,
      sessionManager: manager,
      slackPoster: {
        post: async (channel, threadTs, text) => {
          if (!slackPostResult) return null;
          slackPosts.push({ channel, threadTs, text });
          return slackPostResult;
        },
        react: async () => {},
      },
    };
  }
});

function createHandle(): SpawnHandle {
  let resolveResult!: (result: SpawnResult) => void;
  const result = new Promise<SpawnResult>((res) => {
    resolveResult = res;
  });
  return {
    provider: "claude",
    result,
    onEvent: () => undefined,
    kill: mock(() => {
      resolveResult({
        provider: "claude",
        sessionId: "ses-1",
        response: "",
        events: [],
        exitCode: 130,
        error: "interrupted",
      });
    }),
    pid: 1,
  };
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "s" },
    claude: {
      maxTurns: 25,
      timeoutMs: 300000,
      permissionMode: "bypassPermissions",
      defaultModel: null,
      defaultDriver: "headless",
      tmuxIdleTtlMs: 14_400_000,
      tmuxSweepIntervalMs: 900_000,
    },
    runner: { provider: "claude" },
    opencode: {
      model: null,
      timeoutMs: 300000,
      continuityEnabled: false,
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
    },
    codex: {
      mode: "app-server",
      model: null,
      timeoutMs: 300000,
      sandbox: "workspace-write",
      askForApproval: "never",
      searchEnabled: false,
      appServerContinuityEnabled: false,
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
      memoryMcpEnabled: true,
      isolatedHomePath: "data/codex-home",
    },
    repos: [],
    session: {
      staleTimeoutMs: 86400000,
      cleanupIntervalMs: 900000,
      store: "memory",
      sqlitePath: "data/sessions.db",
      homeWindowMs: 172800000,
      defaultVerbosity: "quiet",
      idleTimeoutMs: 300000,
      maxIdleInterrupts: 3,
      shortFollowupInterruptEnabled: false,
      shortFollowupMaxLength: 280,
    },
    memory: { sqlitePath: "data/memory.db" },
    threadArchives: { dir: "data/thread-archives" },
    channelDefaults: {},
    adminSlackUserId: "UADMIN01",
    http: { enabled: true, port: 0 },
    ...overrides,
  } as Config;
}
