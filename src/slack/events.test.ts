import { describe, it, expect, mock } from "bun:test";
import type { App } from "@slack/bolt";
import {
  registerEventHandlers,
  isForeignBotThinking,
  type SlackMessageEvent,
} from "./events.ts";

type EventHandler = (args: { event: Record<string, unknown> }) => Promise<void> | void;

function makeMockApp() {
  const handlers = new Map<string, EventHandler>();
  const app = {
    event: (name: string, handler: EventHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as App;
  return { app, handlers };
}

describe("isForeignBotThinking", () => {
  it("matches a leading ✽", () => {
    expect(isForeignBotThinking("✽ Thinking…")).toBe(true);
  });

  it("matches ✽ after leading whitespace", () => {
    expect(isForeignBotThinking("   ✽ Brewing…")).toBe(true);
    expect(isForeignBotThinking("\n✽ ...")).toBe(true);
  });

  it("does not match ✽ that appears later in the text", () => {
    expect(isForeignBotThinking("Hello ✽ world")).toBe(false);
  });

  it("does not match a normal user message", () => {
    expect(isForeignBotThinking("hey junior")).toBe(false);
  });

  it("does not match empty string", () => {
    expect(isForeignBotThinking("")).toBe(false);
  });
});

describe("registerEventHandlers — ✽ filter", () => {
  it("message handler drops a sibling-bot ✽ thinking line", async () => {
    const { app, handlers } = makeMockApp();
    const onMessage = mock((_e: SlackMessageEvent) => {});
    registerEventHandlers(app, onMessage);

    const messageHandler = handlers.get("message")!;
    await messageHandler({
      event: {
        type: "message",
        text: "✽ Thinking… (esc to interrupt)",
        channel: "C123",
        channel_type: "im",
        ts: "1700000000.000001",
        user: "U_BOT",
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("message handler drops ✽ even with leading whitespace", async () => {
    const { app, handlers } = makeMockApp();
    const onMessage = mock((_e: SlackMessageEvent) => {});
    registerEventHandlers(app, onMessage);

    await handlers.get("message")!({
      event: {
        type: "message",
        text: "   ✽ still working",
        channel: "C123",
        channel_type: "im",
        ts: "1700000000.000002",
        user: "U_BOT",
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("message handler passes through a normal message", async () => {
    const { app, handlers } = makeMockApp();
    const onMessage = mock((_e: SlackMessageEvent) => {});
    registerEventHandlers(app, onMessage);

    await handlers.get("message")!({
      event: {
        type: "message",
        text: "hello junior",
        channel: "C123",
        channel_type: "im",
        ts: "1700000000.000003",
        user: "U_HUMAN",
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].text).toBe("hello junior");
  });

  it("app_mention handler drops a ✽ thinking line", async () => {
    const { app, handlers } = makeMockApp();
    const onMessage = mock((_e: SlackMessageEvent) => {});
    registerEventHandlers(app, onMessage);

    await handlers.get("app_mention")!({
      event: {
        type: "app_mention",
        text: "✽ Thinking…",
        channel: "C123",
        ts: "1700000000.000004",
        user: "U_BOT",
        thread_ts: "1700000000.000000",
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("self-bot message is dropped in a non-auto-trigger channel without a directive", async () => {
    const { app, handlers } = makeMockApp();
    const onMessage = mock((_e: SlackMessageEvent) => {});
    registerEventHandlers(app, onMessage, undefined, "B_SELF");

    await handlers.get("message")!({
      event: {
        type: "message",
        text: "just talking to myself",
        channel: "C_OTHER",
        channel_type: "channel",
        ts: "1700000000.000010",
        bot_id: "B_SELF",
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("self-bot message with a !<persistent-agent> directive is let through even in non-auto-trigger channels", async () => {
    const { app, handlers } = makeMockApp();
    const onMessage = mock((_e: SlackMessageEvent) => {});
    const store = {
      get: async () => ({ threadId: "T1" }),
    } as unknown as Parameters<typeof registerEventHandlers>[2];
    registerEventHandlers(app, onMessage, store, "B_SELF", "U_BOT");

    await handlers.get("message")!({
      event: {
        type: "message",
        text: "!review take a look at PR 21",
        channel: "C_OTHER",
        channel_type: "channel",
        ts: "1700000000.000011",
        thread_ts: "1700000000.000000",
        bot_id: "B_SELF",
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].text).toContain("!review");
    expect(onMessage.mock.calls[0][0].isSelfBot).toBe(true);
  });

  it("self-bot message with a non-agent !word is still dropped", async () => {
    const { app, handlers } = makeMockApp();
    const onMessage = mock((_e: SlackMessageEvent) => {});
    registerEventHandlers(app, onMessage, undefined, "B_SELF");

    await handlers.get("message")!({
      event: {
        type: "message",
        text: "!notarealagent hello",
        channel: "C_OTHER",
        channel_type: "channel",
        ts: "1700000000.000012",
        bot_id: "B_SELF",
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("app_mention handler passes through a normal mention", async () => {
    const { app, handlers } = makeMockApp();
    const onMessage = mock((_e: SlackMessageEvent) => {});
    registerEventHandlers(app, onMessage, undefined, undefined, "U_BOT");

    await handlers.get("app_mention")!({
      event: {
        type: "app_mention",
        text: "<@U_BOT> hello",
        channel: "C123",
        ts: "1700000000.000005",
        user: "U_HUMAN",
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].text).toBe("hello");
  });
});
