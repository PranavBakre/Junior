import { describe, expect, it } from "bun:test";
import { searchAgentDefinitions, sendSlackDirectMessage } from "./slack-server.ts";

describe("MCP agent search", () => {
  it("finds public agent definitions", async () => {
    const agents = await searchAgentDefinitions({
      query: "default",
      includePublic: true,
      includePrivate: false,
      limit: 10,
    });

    expect(agents.some((agent) => agent.name === "default")).toBe(true);
    expect(agents.every((agent) => agent.origin === "public")).toBe(true);
  });

  it("finds private overlay agent definitions", async () => {
    const agents = await searchAgentDefinitions({
      query: "db-executioner",
      includePublic: false,
      includePrivate: true,
      limit: 10,
    });

    expect(agents).toContainEqual(
      expect.objectContaining({
        name: "db-executioner",
        origin: "private",
        path: "agents-org/db-executioner.md",
      }),
    );
  });
});

describe("MCP Slack DM helper", () => {
  it("opens a DM channel before posting to a user", async () => {
    const calls: unknown[] = [];
    const client = {
      conversations: {
        open: async (args: unknown) => {
          calls.push(["open", args]);
          return { channel: { id: "D123" } };
        },
      },
      chat: {
        postMessage: async (args: unknown) => {
          calls.push(["postMessage", args]);
          return { ts: "123.456" };
        },
      },
    };

    await expect(
      sendSlackDirectMessage(client, {
        userId: "U123",
        text: "secret",
        username: "Onboarding Guide",
        iconEmoji: ":compass:",
      }),
    ).resolves.toEqual({ channelId: "D123", ts: "123.456" });

    expect(calls).toEqual([
      ["open", { users: "U123", return_im: true }],
      [
        "postMessage",
        {
          channel: "D123",
          text: "secret",
          username: "Onboarding Guide",
          icon_emoji: ":compass:",
        },
      ],
    ]);
  });
});
