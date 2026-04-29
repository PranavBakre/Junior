import { describe, expect, it, mock } from "bun:test";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { SessionManager } from "../session/manager.ts";
import { parseAgentDirectives, SupportRouter } from "./router.ts";

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

describe("SupportRouter", () => {
  it("routes unprefixed support-channel messages to lead", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new SupportRouter(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

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
    const router = new SupportRouter(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

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

  it("does not let worker-authored bot messages dispatch agents", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new SupportRouter(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "!thinker do this",
        isSelfBot: true,
        botUsername: "Reproducer",
      }),
    );

    // Worker self-bot directives get re-routed to lead as plain text.
    expect(managerMock.handleLeadMessage).toHaveBeenCalledTimes(1);
    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
  });

  it("drops lead's own no-directive commentary to break the wake-loop", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new SupportRouter(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

    await router.handleMessage(
      makeEvent({
        text: "research done, waiting on sentry/vercel",
        isSelfBot: true,
        botUsername: "Junior",
      }),
    );

    expect(managerMock.handleMessage).not.toHaveBeenCalled();
    expect(managerMock.handleAgentMessage).not.toHaveBeenCalled();
  });

  it("forwards worker no-directive responses to lead", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new SupportRouter(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

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
    const router = new SupportRouter(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

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
    const router = new SupportRouter(
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
    const router = new SupportRouter(
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

  it("drops self-bot posts with unknown username (no usable identity)", async () => {
    const managerMock = {
      handleMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleLeadMessage: mock(async (_event: SlackMessageEvent) => {}),
      handleAgentMessage: mock(async (_event: SlackMessageEvent, _agent: string) => {}),
    };
    const router = new SupportRouter(managerMock as unknown as SessionManager, new Set(["CBUGS"]));

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
