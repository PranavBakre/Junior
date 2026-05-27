import { describe, expect, it, mock } from "bun:test";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { SessionManager } from "../session/manager.ts";
import { parseAgentDirectives, parseDevserverDirective, AgentDispatcher } from "./router.ts";
import type { MemoryStore } from "../memory/store.ts";

function makeEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    threadId: "thread-1",
    channel: "CBUGS",
    user: "U123",
    text: "hello",
    ts: "123.456",
    command: null,
    ...overrides,
  };
}

describe("parseAgentDirectives", () => {
  it("extracts persistent-agent directive lines", () => {
    expect(
      parseAgentDirectives("status\n!echo hello\n!reproducer go"),
    ).toEqual([
      { agentName: "echo", prompt: "hello", line: "!echo hello" },
      { agentName: "reproducer", prompt: "go", line: "!reproducer go" },
    ]);
  });

  it("ignores sub-agent-looking directives", () => {
    expect(parseAgentDirectives("!nr-research check logs")).toEqual([]);
  });
});

describe("AgentDispatcher", () => {
  it("routes unprefixed support-channel messages to lead", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(makeEvent({ text: "plain bug" }));

    expect(managerMock.handleLeadMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
  });

  it("dispatches each recognized directive to its agent", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({ text: "!echo first\ncommentary\n!reproducer second" }),
    );

    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).toHaveBeenCalledTimes(2);
    expect(managerMock.handleAgentMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "first", dedupeKey: "123.456:echo:0" }),
      "echo",
    );
    expect(managerMock.handleAgentMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "second",
        dedupeKey: "123.456:reproducer:1",
      }),
      "reproducer",
    );
  });

  it("does not let workers dispatch agents outside the allow-list", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "!thinker do this",
        isSelfBot: true,
        botUsername: "Reproducer",
      }),
    );

    // Reproducer is not allowed to dispatch thinker — stripped, re-routed to lead.
    expect(managerMock.handleLeadMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
  });

  it("lets thinker dispatch !review (allow-listed worker chain)", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "scoping done — see PR #5033\n!review check the conditional Joi validation",
        isSelfBot: true,
        botUsername: "Thinker",
      }),
    );

    expect(managerMock.handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "check the conditional Joi validation" }),
      "review",
    );
    // Lead does not get a re-route copy when the directive was allowed.
    expect(managerMock.handleLeadMessage).not.toHaveBeenCalled();
    expect(managerMock.handleMessage).not.toHaveBeenCalled();
  });

  it("lets thinker dispatch !reproducer for validation (allow-listed worker chain)", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "scoping done — see PR\n!reproducer validate the fix on branch feature/abc123",
        isSelfBot: true,
        botUsername: "Thinker",
      }),
    );

    expect(managerMock.handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "validate the fix on branch feature/abc123",
      }),
      "reproducer",
    );
    expect(managerMock.handleLeadMessage).not.toHaveBeenCalled();
  });

  it("dispatches both !review and !reproducer when thinker emits both", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text:
          "scoping done — see PR\n!reproducer validate fix on branch feature/abc123\n!review check Joi conditional",
        isSelfBot: true,
        botUsername: "Thinker",
      }),
    );

    expect(managerMock.handleAgentMessage).toHaveBeenCalledTimes(2);
    expect(managerMock.handleLeadMessage).not.toHaveBeenCalled();
    const targets = managerMock.handleAgentMessage.mock.calls.map((c) => c[1]);
    expect(targets).toContain("reproducer");
    expect(targets).toContain("review");
  });

  it("drops lead's own no-directive commentary to break the wake-loop", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "research done, waiting on sentry/vercel",
        isSelfBot: true,
        botUsername: "Junior (Lead)",
      }),
    );

    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
  });

  it("drops default Junior's own no-directive commentary to break the wake-loop", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "checking the script, one moment",
        isSelfBot: true,
        botUsername: "Junior",
      }),
    );

    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
    expect(managerMock.handleLeadMessage).not.toHaveBeenCalled();
  });

  it("default Junior may dispatch multiple core workers in a non-support channel", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    // No support channels — exercises the non-support dispatch path.
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set());

    await router.handleMessage(
      makeEvent({
        text: "!review take a look at PR 21\n!thinker root-cause the timeout",
        isSelfBot: true,
        botUsername: "Junior",
        channel: "C_TECH",
      }),
    );

    const targets = managerMock.handleAgentMessage.mock.calls.map((c) => c[1]);
    expect(targets).toContain("review");
    expect(targets).toContain("thinker");
  });

  it("forwards worker no-directive responses to lead", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "reproduced — 500 on /events    by reproducer",
        isSelfBot: true,
        botUsername: "Reproducer",
      }),
    );

    expect(managerMock.handleLeadMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
  });

  it("dispatches when parseCommand consumed a !<persistent-agent> token into event.command", async () => {
    // Simulates the case where commands.ts parseCommand runs first and turns
    // `!review PR #732 details...` into { command: "review", text: "PR #732 details..." }.
    // The router must reconstruct the directive — otherwise the dispatch silently drops.
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "PR #732 details about the change",
        command: "review",
      }),
    );

    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "PR #732 details about the change" }),
      "review",
    );
  });

  it("dispatches !<persistent-agent> directives in non-support channels too", async () => {
    // The unified dispatcher fires for any channel — `!review` in #junior should
    // spawn a persistent review session, same as in #bugs-backlog.
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(
      managerMock as unknown as SessionManager,
      new Set(["CBUGS"]), // CBUGS is the only support channel; CJUNIOR is not
    );

    await router.handleMessage(
      makeEvent({
        channel: "CJUNIOR", // non-support channel
        text: "!review PR #4900 details",
      }),
    );

    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "PR #4900 details" }),
      "review",
    );
  });

  it("falls through to single-session manager for non-support channels with no directives", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(
      managerMock as unknown as SessionManager,
      new Set(["CBUGS"]),
    );

    await router.handleMessage(
      makeEvent({
        channel: "CJUNIOR",
        text: "fix the auth middleware",
      }),
    );

    // Routed to manager.handleMessage, but WITHOUT a `${ts}:lead` dedupeKey
    // (that's a support-channel-only thing — non-support has no lead).
    expect(managerMock.handleMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
    const call = managerMock.handleMessage.mock.calls[0][0];
    expect(call.dedupeKey).toBeUndefined();
  });

  it("auto-dispatches GitHub PR review requests to review in non-support channels", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(
      managerMock as unknown as SessionManager,
      new Set(["CBUGS"]),
    );

    await router.handleMessage(
      makeEvent({
        channel: "CTECH",
        text: "https://github.com/GrowthX-Club/gx-backend/pull/3150 please review",
      }),
    );

    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleLeadMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "123.456:review:auto" }),
      "review",
    );
  });

  it("uses routing memory body even when the memory has a title", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const memoryStore = {
      recall: mock(async () => [
        {
          id: "routing-1",
          kind: "routing_memory",
          title: "Learned routing memory",
          body: "Send pull request review requests to review.",
          outcome: null,
          score: 1,
          reasons: [],
          sourceIds: [],
        },
      ]),
    } as unknown as MemoryStore;
    const router = new AgentDispatcher(
      managerMock as unknown as SessionManager,
      new Set(),
      { memoryStore },
    );

    await router.handleMessage(makeEvent({ channel: "C_GENERAL", text: "please look at this PR" }));

    expect(managerMock.handleAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "123.456:review:memory" }),
      "review",
    );
    expect(managerMock.handleMessage).not.toHaveBeenCalled();
  });

  it("drops self-bot posts with unknown username (no usable identity)", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new AgentDispatcher(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "something",
        isSelfBot: true,
        botUsername: undefined,
      }),
    );

    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseDevserverDirective — covered more exhaustively in dev-server-queue.test.ts,
// but a few smoke checks here to ensure the router import path is wired.
// ---------------------------------------------------------------------------

describe("parseDevserverDirective (router smoke)", () => {
  it("parses !devserver status", () => {
    expect(parseDevserverDirective("!devserver status")).toEqual({ kind: "status" });
  });

  it("parses !devserver kill <repo>", () => {
    expect(parseDevserverDirective("!devserver kill app-backend")).toEqual({
      kind: "kill",
      repo: "app-backend",
    });
  });

  it("returns null for non-devserver input", () => {
    expect(parseDevserverDirective("hello world")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// !devserver directive interception in AgentDispatcher
// ---------------------------------------------------------------------------

describe("AgentDispatcher !devserver interception", () => {
  it("intercepts !devserver and does NOT dispatch to any agent", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };

    // Minimal devServerQueue stub — acquire resolves immediately.
    const queueMock = {
      acquire: mock(async () => ({
        release: async () => {},
        info: { pid: 1, port: 3000, readyUrl: "http://localhost:3000" },
      })),
      readQueueDepth: mock(async () => ({ holder: null, waiters: [] })),
    };

    const slackClientMock = {
      chat: {
        postMessage: mock(async () => ({ ts: "123.456" })),
      },
    };

    const router = new AgentDispatcher(
      managerMock as unknown as SessionManager,
      new Set(["CBUGS"]),
      {
        devServerQueue: queueMock as unknown as import("../lifecycle/dev-server-queue.ts").DevServerQueue,
        slackClient: slackClientMock as unknown as import("@slack/web-api").WebClient,
        repos: [
          {
            name: "app-backend",
            path: "/tmp/app-backend",
            defaultBase: "origin/main",
            devCommand: "echo dev",
            devPort: 8000,
          },
        ],
      },
    );

    // !devserver status — should be handled inline.
    await router.handleMessage(
      makeEvent({ channel: "CBUGS", text: "!devserver status" }),
    );

    // No agent should have been dispatched.
    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleLeadMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();

    // Slack client should have been called to post the status reply.
    expect(slackClientMock.chat.postMessage).toHaveBeenCalled();
  });

  it("falls through to normal routing when no !devserver directive is present", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };

    const router = new AgentDispatcher(
      managerMock as unknown as SessionManager,
      new Set(["CBUGS"]),
    );

    await router.handleMessage(makeEvent({ channel: "CBUGS", text: "plain bug message" }));

    // Routed to lead (support channel, no directive).
    expect(managerMock.handleLeadMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
  });
});
