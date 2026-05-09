import { describe, it, expect, beforeEach, mock } from "bun:test";
import type {
  SpawnHandle,
  SpawnResult,
  StreamEvent,
} from "../claude/types.ts";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { Config } from "../config.ts";

// --- Mock setup ---

interface MockHandle extends SpawnHandle {
  _complete: (response?: string, sessionId?: string) => void;
  _error: (errorMsg: string) => void;
}

function createMockHandle(
  response: string = "ok",
  sessionId: string = "test-session",
): MockHandle {
  const listeners: Array<(event: StreamEvent) => void> = [];
  let resolveResult!: (result: SpawnResult) => void;
  const result = new Promise<SpawnResult>((res) => {
    resolveResult = res;
  });

  return {
    result,
    onEvent: (cb) => listeners.push(cb),
    kill: mock(() => {}),
    pid: 12345,
    _complete: (resp?: string, sid?: string) => {
      const finalResponse = resp ?? response;
      const finalSessionId = sid ?? sessionId;
      for (const l of listeners)
        l({
          type: "system",
          subtype: "init",
          session_id: finalSessionId,
        });
      for (const l of listeners)
        l({ type: "result", subtype: "success", text: finalResponse });
      resolveResult({
        sessionId: finalSessionId,
        response: finalResponse,
        events: [],
        exitCode: 0,
        error: null,
      });
    },
    _error: (errorMsg: string) => {
      resolveResult({
        sessionId: null,
        response: "",
        events: [],
        exitCode: 1,
        error: errorMsg,
      });
    },
  };
}

let mockSpawnFn: ReturnType<typeof mock<(session: unknown, prompt: unknown, config: unknown) => MockHandle>> = mock(
  (_session: unknown, _prompt: unknown, _config: unknown) => createMockHandle(),
);

// Mock spawnClaude
mock.module("../claude/spawner.ts", () => ({
  spawnClaude: (session: unknown, prompt: unknown, config: unknown) =>
    mockSpawnFn(session, prompt, config),
}));

// Mock withTimeout to pass through the handle as-is (no real timeout)
mock.module("../lifecycle/timeout.ts", () => ({
  withTimeout: (handle: SpawnHandle, _timeoutMs: number, _onTimeout?: () => void) => handle,
}));

// Import after mocking
const { SessionManager } = await import("./manager.ts");
import { InMemorySessionStore } from "./store/memory.ts";

// --- Helpers ---

const testConfig: Config = {
  slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "s" },
  claude: { maxTurns: 25, timeoutMs: 300000, permissionMode: "bypassPermissions", defaultModel: null },
  repos: [
    { name: "junior", path: "/tmp/junior", defaultBase: "main" },
    { name: "frontend", path: "/tmp/frontend", defaultBase: "main" },
  ],
  session: {
    staleTimeoutMs: 86400000,
    cleanupIntervalMs: 900000,
    store: "sqlite",
    sqlitePath: "data/sessions.db",
    homeWindowMs: 172800000,
    defaultVerbosity: "quiet",
  },
  channelDefaults: {},
  adminSlackUserId: null,
  http: { enabled: false, port: 0 },
};

function makeEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    threadId: "thread-1",
    channel: "C123",
    user: "U123",
    text: "Hello Claude",
    ts: "1234567890.123456",
    command: null,
    ...overrides,
  };
}

describe("SessionManager", () => {
  let store: InMemorySessionStore;
  let manager: InstanceType<typeof SessionManager>;
  let currentHandle: MockHandle;

  beforeEach(() => {
    store = new InMemorySessionStore();
    manager = new SessionManager(store, testConfig);

    currentHandle = createMockHandle();
    mockSpawnFn = mock(() => currentHandle);
  });

  // --- Session creation and basic flow ---

  it("creates a session for a new thread", async () => {
    const event = makeEvent();
    await manager.handleMessage(event);

    const session = await store.get("thread-1");
    expect(session).toBeDefined();
    expect(session!.threadId).toBe("thread-1");
    expect(session!.channel).toBe("C123");
    expect(session!.status).toBe("busy");
  });

  it("sets status to busy on idle thread", async () => {
    const event = makeEvent();
    await manager.handleMessage(event);

    const session = await store.get("thread-1");
    expect(session!.status).toBe("busy");
  });

  it("calls spawnClaude with the prompt text", async () => {
    const event = makeEvent({ text: "Build me a feature" });
    await manager.handleMessage(event);

    expect(mockSpawnFn).toHaveBeenCalledTimes(1);
    const callArgs = mockSpawnFn.mock.calls[0];
    // Second arg is the prompt
    expect(callArgs[1]).toBe("Build me a feature");
  });

  // --- Message buffering ---

  it("buffers message when thread is busy", async () => {
    const onBuffered = mock(() => {});
    manager.onMessageBuffered = onBuffered;

    // First message makes it busy
    await manager.handleMessage(makeEvent({ text: "First message" }));
    expect((await store.get("thread-1"))!.status).toBe("busy");

    // Second message while busy -> buffered
    const event2 = makeEvent({ text: "Second message", ts: "ts-2" });
    await manager.handleMessage(event2);

    const session = await store.get("thread-1");
    expect(session!.pendingMessages.length).toBe(1);
    expect(session!.pendingMessages[0].text).toBe("Second message");
    expect(onBuffered).toHaveBeenCalledTimes(1);
  });

  it("creates an independent persistent agent session", async () => {
    const responses: Array<{ agentName?: string; username?: string; response: string }> = [];
    manager.onResponse = (session, response) => {
      responses.push({
        agentName: session.activeAgentName,
        username: session.slackIdentity?.username,
        response,
      });
    };

    await manager.handleAgentMessage(makeEvent({ text: "hello echo" }), "echo");

    let session = await store.get("thread-1");
    expect(session!.status).toBe("idle");
    expect(session!.agentSessions.echo.status).toBe("busy");

    const runSession = mockSpawnFn.mock.calls[0][0] as { activeAgentName?: string; slackIdentity?: { username: string } };
    expect(runSession.activeAgentName).toBe("echo");
    expect(runSession.slackIdentity?.username).toBe("Echo");

    currentHandle._complete("echo response", "echo-session-1");
    await new Promise((r) => setTimeout(r, 10));

    session = await store.get("thread-1");
    expect(session!.agentSessions.echo.sessionId).toBe("echo-session-1");
    expect(session!.agentSessions.echo.status).toBe("done");
    expect(session!.sessionId).toBeNull();
    expect(responses).toEqual([
      { agentName: "echo", username: "Echo", response: "echo response" },
    ]);
  });

  it("buffers per-agent messages while that agent is busy and drains them", async () => {
    await manager.handleAgentMessage(makeEvent({ text: "first echo" }), "echo");
    await manager.handleAgentMessage(
      makeEvent({ text: "second echo", ts: "ts-2" }),
      "echo",
    );

    let session = await store.get("thread-1");
    expect(session!.agentSessions.echo.pendingMessages).toHaveLength(1);
    expect(session!.agentSessions.echo.pendingMessages[0].text).toBe("second echo");

    const drainHandle = createMockHandle();
    mockSpawnFn = mock(() => drainHandle);

    currentHandle._complete("first response", "echo-session-1");
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSpawnFn).toHaveBeenCalledTimes(1);
    const drainPrompt = mockSpawnFn.mock.calls[0][1] as string;
    expect(drainPrompt).toContain("[U123]: second echo");

    drainHandle._complete("second response", "echo-session-1");
    await new Promise((r) => setTimeout(r, 10));

    session = await store.get("thread-1");
    expect(session!.agentSessions.echo.pendingMessages).toHaveLength(0);
    expect(session!.agentSessions.echo.status).toBe("done");
  });

  // --- Completion and response ---

  it("fires onResponse and sets status to idle after Claude completes", async () => {
    const responses: string[] = [];
    manager.onResponse = (_session, response) => responses.push(response);

    await manager.handleMessage(makeEvent({ text: "Do something" }));
    currentHandle._complete("Here is the answer");

    // Let microtasks flush
    await new Promise((r) => setTimeout(r, 10));

    const session = await store.get("thread-1");
    expect(session!.status).toBe("idle");
    expect(responses).toEqual(["Here is the answer"]);
  });

  it("captures sessionId from init event", async () => {
    await manager.handleMessage(makeEvent());
    currentHandle._complete("response", "claude-session-42");

    await new Promise((r) => setTimeout(r, 10));

    const session = await store.get("thread-1");
    expect(session!.sessionId).toBe("claude-session-42");
  });

  // --- Buffer drain ---

  it("drains buffered messages after Claude completes", async () => {
    // First message -> busy
    await manager.handleMessage(makeEvent({ text: "First" }));

    // Buffer a second message
    await manager.handleMessage(
      makeEvent({ text: "Second", ts: "ts-2", user: "U456" }),
    );
    expect((await store.get("thread-1"))!.pendingMessages.length).toBe(1);

    // Prepare a new handle for the drain turn
    const drainHandle = createMockHandle();
    mockSpawnFn = mock(() => drainHandle);

    // Complete the first run
    currentHandle._complete("First response");
    await new Promise((r) => setTimeout(r, 10));

    // spawnClaude should have been called again for the buffered message
    expect(mockSpawnFn).toHaveBeenCalledTimes(1);
    const drainPrompt = mockSpawnFn.mock.calls[0][1] as string;
    expect(drainPrompt).toContain("[U456]: Second");

    // Session should be in draining/busy
    const session = await store.get("thread-1");
    expect(session!.pendingMessages.length).toBe(0);
  });

  // --- Commands ---

  describe("!reset", () => {
    it("rejects bare !reset with usage help", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;
      await manager.handleMessage(makeEvent({ text: "Work on this" }));

      await manager.handleMessage(makeEvent({ command: "reset", text: "", ts: "ts-reset" }));

      // Session must NOT be deleted — bare !reset is a usage error
      expect(await store.get("thread-1")).toBeDefined();
      expect(currentHandle.kill).not.toHaveBeenCalled();
      expect(onCmd).toHaveBeenCalledTimes(1);
      expect(onCmd.mock.calls[0][1]).toContain("Usage:");
    });

    it("!reset all kills running process and deletes session", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;
      await manager.handleMessage(makeEvent({ text: "Work on this" }));

      await manager.handleMessage(makeEvent({ command: "reset", text: "all", ts: "ts-reset" }));

      expect(await store.get("thread-1")).toBeUndefined();
      expect(currentHandle.kill).toHaveBeenCalled();
      expect(onCmd).toHaveBeenCalledTimes(1);
      expect(onCmd.mock.calls[0][1]).toBe("Session reset.");
    });

    it("!reset <agent> clears only that agent's slice", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;
      await manager.handleAgentMessage(makeEvent({ text: "hello" }), "echo");
      currentHandle._complete("echo response", "echo-session-1");
      await new Promise((r) => setTimeout(r, 10));

      // Set lead state too so we can verify it's untouched
      let session = await store.get("thread-1");
      session!.sessionId = "lead-session-1";
      session!.leadSessionId = "lead-session-1";
      await store.set("thread-1", session!);

      await manager.handleMessage(makeEvent({ command: "reset", text: "echo", ts: "ts-reset" }));

      session = await store.get("thread-1");
      expect(session!.agentSessions.echo).toBeUndefined();
      // Lead state untouched
      expect(session!.leadSessionId).toBe("lead-session-1");
      expect(onCmd.mock.calls[0][1]).toContain("Reset *echo*");
    });

    it("!reset <agent> mid-flight survives the killed run completing", async () => {
      // Regression: previously, a !reset that killed an in-flight run was
      // clobbered by the killed run's onRunComplete writing back the stale
      // sessionId / recreating the agent slice via getOrCreateAgentSession.
      await manager.handleAgentMessage(makeEvent({ text: "go" }), "echo");
      let session = await store.get("thread-1");
      expect(session!.agentSessions.echo.status).toBe("busy");

      // Reset while the run is still in flight (no _complete yet)
      await manager.handleMessage(
        makeEvent({ command: "reset", text: "echo", ts: "ts-reset" }),
      );
      session = await store.get("thread-1");
      expect(session!.agentSessions.echo).toBeUndefined();
      expect(currentHandle.kill).toHaveBeenCalled();

      // Killed process exits with a "normal" result — must NOT recreate the slice
      currentHandle._complete("late response", "stale-session-id");
      await new Promise((r) => setTimeout(r, 10));

      session = await store.get("thread-1");
      expect(session!.agentSessions.echo).toBeUndefined();
    });

    it("!reset all mid-flight survives the killed run completing", async () => {
      // Same race as above but for the top-level lead/default path
      await manager.handleMessage(makeEvent({ text: "go" }));
      expect((await store.get("thread-1"))!.status).toBe("busy");

      await manager.handleMessage(
        makeEvent({ command: "reset", text: "all", ts: "ts-reset-all" }),
      );
      expect(await store.get("thread-1")).toBeUndefined();
      expect(currentHandle.kill).toHaveBeenCalled();

      // Killed process exits — must NOT recreate the row from the snapshot
      currentHandle._complete("late response", "stale-session-id");
      await new Promise((r) => setTimeout(r, 10));

      expect(await store.get("thread-1")).toBeUndefined();
    });

    it("!reset <unknown-agent> reports nothing to reset", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;
      await manager.handleMessage(makeEvent({ text: "Work on this" }));

      await manager.handleMessage(
        makeEvent({ command: "reset", text: "nonexistent", ts: "ts-reset" }),
      );

      expect(onCmd.mock.calls[0][1]).toContain("Nothing to reset");
    });

    describe("admin gating", () => {
      const adminConfig: Config = { ...testConfig, adminSlackUserId: "U-ADMIN" };

      it("non-admin gets ❌ reaction and command is ignored", async () => {
        const adminManager = new SessionManager(store, adminConfig);
        const onReaction = mock((_e: SlackMessageEvent, _emoji: string) => {});
        const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
        adminManager.onReaction = onReaction;
        adminManager.onCommandResponse = onCmd;
        await adminManager.handleMessage(makeEvent({ user: "U-ADMIN", text: "go" }));

        await adminManager.handleMessage(
          makeEvent({ user: "U-OTHER", command: "reset", text: "all", ts: "ts-reset" }),
        );

        expect(onReaction).toHaveBeenCalledTimes(1);
        expect(onReaction.mock.calls[0][1]).toBe("x");
        // Session not deleted
        expect(await store.get("thread-1")).toBeDefined();
        expect(onCmd).not.toHaveBeenCalled();
      });

      it("non-admin bare !reset is silently ❌'d (no usage leak)", async () => {
        const adminManager = new SessionManager(store, adminConfig);
        const onReaction = mock((_e: SlackMessageEvent, _emoji: string) => {});
        const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
        adminManager.onReaction = onReaction;
        adminManager.onCommandResponse = onCmd;
        await adminManager.handleMessage(makeEvent({ user: "U-ADMIN", text: "go" }));

        await adminManager.handleMessage(
          makeEvent({ user: "U-OTHER", command: "reset", text: "", ts: "ts-reset" }),
        );

        expect(onReaction).toHaveBeenCalledTimes(1);
        expect(onReaction.mock.calls[0][1]).toBe("x");
        // CRITICAL: the usage hint must NOT have been posted to thread —
        // would leak the gating model and contradict the silent-deny promise.
        expect(onCmd).not.toHaveBeenCalled();
      });

      it("admin can run !reset all", async () => {
        const adminManager = new SessionManager(store, adminConfig);
        const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
        adminManager.onCommandResponse = onCmd;
        await adminManager.handleMessage(makeEvent({ user: "U-ADMIN", text: "go" }));

        await adminManager.handleMessage(
          makeEvent({ user: "U-ADMIN", command: "reset", text: "all", ts: "ts-reset" }),
        );

        expect(await store.get("thread-1")).toBeUndefined();
        expect(onCmd.mock.calls[0][1]).toBe("Session reset.");
      });

      it("non-admin !mute is ignored with ❌", async () => {
        const adminManager = new SessionManager(store, adminConfig);
        const onReaction = mock((_e: SlackMessageEvent, _emoji: string) => {});
        adminManager.onReaction = onReaction;
        await adminManager.handleMessage(makeEvent({ user: "U-ADMIN", text: "go" }));

        await adminManager.handleMessage(
          makeEvent({ user: "U-OTHER", command: "mute", text: "", ts: "ts-mute" }),
        );

        expect(onReaction).toHaveBeenCalledTimes(1);
        expect(onReaction.mock.calls[0][1]).toBe("x");
        expect((await store.get("thread-1"))!.muted).toBe(false);
      });

      it("when adminSlackUserId is null, gate is open", async () => {
        // testConfig has adminSlackUserId: null
        const onReaction = mock((_e: SlackMessageEvent, _emoji: string) => {});
        manager.onReaction = onReaction;
        await manager.handleMessage(makeEvent({ user: "U-ANYONE", text: "go" }));

        await manager.handleMessage(
          makeEvent({ user: "U-ANYONE", command: "mute", text: "", ts: "ts-mute" }),
        );

        expect(onReaction).not.toHaveBeenCalled();
        expect((await store.get("thread-1"))!.muted).toBe(true);
      });
    });
  });

  describe("!status", () => {
    it("returns session info via onCommandResponse", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      // Create a session
      await manager.handleMessage(makeEvent({ text: "Start" }));

      // Check status
      const statusEvent = makeEvent({ command: "status", text: "", ts: "ts-status" });
      await manager.handleMessage(statusEvent);

      expect(onCmd).toHaveBeenCalledTimes(1);
      const response = onCmd.mock.calls[0][1] as string;
      expect(response).toContain("*Status:*");
      expect(response).toContain("*Agent:*");
      expect(response).toContain("*Pending messages:*");
    });
  });

  describe("!build", () => {
    it("sets agentType and continues to Claude", async () => {
      const event = makeEvent({ command: "build", text: "Build a feature" });
      await manager.handleMessage(event);

      const session = await store.get("thread-1");
      expect(session!.agentType).toBe("build");
      // Should still proceed to spawn (command returns false -> not fully handled)
      expect(session!.status).toBe("busy");
      expect(mockSpawnFn).toHaveBeenCalled();
    });
  });

  describe("!frontend", () => {
    it("sets agentType to frontend and continues to Claude", async () => {
      const event = makeEvent({ command: "frontend", text: "Style the page" });
      await manager.handleMessage(event);

      const session = await store.get("thread-1");
      expect(session!.agentType).toBe("frontend");
      expect(session!.status).toBe("busy");
    });
  });

  // !review was removed from KNOWN_COMMANDS (it's now a persistent-agent
  // directive handled by the dispatcher) — no manager-level test here.

  describe("!architect", () => {
    it("sets agentType to architect and continues to Claude", async () => {
      const event = makeEvent({ command: "architect", text: "Design the system" });
      await manager.handleMessage(event);

      const session = await store.get("thread-1");
      expect(session!.agentType).toBe("architect");
    });
  });

  describe("verbosity commands", () => {
    it("!quiet sets verbosity to quiet", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      // Create session first
      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "quiet", text: "", ts: "ts-quiet" }),
      );

      const session = await store.get("thread-1");
      expect(session!.verbosity).toBe("quiet");
      expect(onCmd).toHaveBeenCalledWith(
        expect.anything(),
        "Quiet mode.",
      );
    });

    it("!verbose sets verbosity to verbose", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "verbose", text: "", ts: "ts-verbose" }),
      );

      const session = await store.get("thread-1");
      expect(session!.verbosity).toBe("verbose");
      expect(onCmd).toHaveBeenCalledWith(
        expect.anything(),
        "Verbose mode.",
      );
    });

    it("!normal sets verbosity to normal", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      // Set to quiet first, then back to normal
      await manager.handleMessage(
        makeEvent({ command: "quiet", text: "", ts: "ts-quiet2" }),
      );
      await manager.handleMessage(
        makeEvent({ command: "normal", text: "", ts: "ts-normal" }),
      );

      const session = await store.get("thread-1");
      expect(session!.verbosity).toBe("normal");
    });
  });

  describe("!repo", () => {
    it("sets targetRepo when valid", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      // Create session
      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "repo", text: "junior", ts: "ts-repo" }),
      );

      const session = await store.get("thread-1");
      expect(session!.targetRepo).toBe("junior");
      expect(onCmd.mock.calls[0][1]).toContain("junior");
    });

    it("reports error for invalid repo", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "repo", text: "nonexistent-repo", ts: "ts-repo-bad" }),
      );

      const response = onCmd.mock.calls[0][1] as string;
      expect(response).toContain("Unknown repo");
      expect(response).toContain("junior");
      expect(response).toContain("frontend");
    });
  });

  describe("!branch", () => {
    it("sets baseRef on the session", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "branch", text: "feature/new-thing", ts: "ts-branch" }),
      );

      const session = await store.get("thread-1");
      expect(session!.baseRef).toBe("feature/new-thing");
      expect(onCmd.mock.calls[0][1]).toContain("feature/new-thing");
    });
  });

  describe("!help", () => {
    it("returns help text", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "help", text: "", ts: "ts-help" }),
      );

      expect(onCmd).toHaveBeenCalled();
      const response = onCmd.mock.calls[0][1] as string;
      expect(response).toContain("!build");
      expect(response).toContain("!reset");
      expect(response).toContain("!status");
    });
  });

  // --- Error handling ---

  it("fires onError and sets session idle when spawn returns an error", async () => {
    const errors: string[] = [];
    manager.onError = (_session, error) => {
      if (error) errors.push(error);
    };

    await manager.handleMessage(makeEvent({ text: "Do something" }));
    currentHandle._error("Claude crashed");

    await new Promise((r) => setTimeout(r, 10));

    const session = await store.get("thread-1");
    expect(session!.status).toBe("idle");
    expect(session!.lastError).not.toBeNull();
    expect(session!.lastError!.message).toBe("Claude crashed");
    expect(errors).toEqual(["Claude crashed"]);
  });

  // --- onEvent forwarding ---

  it("forwards stream events via onEvent", async () => {
    const events: StreamEvent[] = [];
    manager.onEvent = (_session, event) => events.push(event);

    await manager.handleMessage(makeEvent({ text: "Go" }));
    currentHandle._complete("Done");

    await new Promise((r) => setTimeout(r, 10));

    // Should have received init + result events
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("system");
    expect(events[1].type).toBe("result");
  });

  // --- getSession ---

  it("getSession returns existing session", async () => {
    await manager.handleMessage(makeEvent());

    const session = await manager.getSession("thread-1");
    expect(session).toBeDefined();
    expect(session!.threadId).toBe("thread-1");
  });

  it("getSession returns undefined for unknown thread", async () => {
    const session = await manager.getSession("unknown");
    expect(session).toBeUndefined();
  });
});
