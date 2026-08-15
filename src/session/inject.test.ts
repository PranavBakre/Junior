import { describe, expect, it, mock } from "bun:test";
import type { SpawnHandle, SpawnResult, SpawnRunnerFn } from "../runners/types.ts";
import type { Config } from "../config.ts";
import { toDashboardSlackEvent } from "./inject.ts";
import { createSession } from "./types.ts";
import { InMemorySessionStore } from "./store/memory.ts";
import { SessionManager } from "./manager.ts";

describe("toDashboardSlackEvent", () => {
  it("builds an attribution-only inject event with dashboardContinue", () => {
    const event = toDashboardSlackEvent({
      threadId: "1712345678.123456",
      channel: "C123",
      prompt: "!review please inspect this",
      actorSlackUserId: "UADMIN01",
      postedTs: "1712345678.999999",
    });

    expect(event).toEqual({
      threadId: "1712345678.123456",
      channel: "C123",
      user: "UADMIN01",
      attributionUserId: "UADMIN01",
      text: "!review please inspect this",
      conversationalText: "!review please inspect this",
      ts: "1712345678.999999",
      command: null,
      isSelfBot: true,
      botUsername: "dashboard",
      dedupeKey: "dashboard:1712345678.123456:1712345678.999999",
      dashboardContinue: true,
    });
    expect(event.dedupeKey).not.toBe(event.ts);
    expect(event.dedupeKey).not.toBe(`${event.ts}:review`);
  });
});

describe("injectDashboardContinue dormant wake", () => {
  it("clears dormant and sets needsThreadCatchup before dispatch", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("thread-1", "C123");
    session.dormant = true;
    session.needsThreadCatchup = false;
    await store.set(session.threadId, session);

    const spawn = mock<SpawnRunnerFn>((() => createHandle()) as SpawnRunnerFn);
    const manager = new SessionManager(store, testConfig(), spawn);

    const result = await manager.injectDashboardContinue({
      threadId: "thread-1",
      channel: "C123",
      prompt: "catch me up",
      actorSlackUserId: "UADMIN01",
      postedTs: "9.9",
    });

    expect(result).toEqual({ status: "accepted" });
    const after = await store.get("thread-1");
    expect(after?.dormant).toBe(false);
    expect(after?.needsThreadCatchup).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

function createHandle(): SpawnHandle {
  const result = new Promise<SpawnResult>(() => {});
  return {
    provider: "claude",
    result,
    onEvent: () => undefined,
    kill: mock(() => {}),
    pid: 1,
  };
}

function testConfig(): Config {
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
  } as Config;
}
