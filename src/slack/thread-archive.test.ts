import { describe, expect, it } from "bun:test";
import {
  deleteJuniorMessages,
  fetchFullThreadReplies,
  formatThreadArchiveMarkdown,
  isJuniorMessage,
  type ArchivedMessage,
  type ThreadArchiveMeta,
} from "./thread-archive.ts";

describe("isJuniorMessage", () => {
  it("matches self bot_id", () => {
    expect(isJuniorMessage({ bot_id: "B_SELF" }, "B_SELF", "U_BOT")).toBe(true);
  });

  it("matches bot user id when bot_id absent", () => {
    expect(isJuniorMessage({ user: "U_BOT" }, "B_SELF", "U_BOT")).toBe(true);
  });

  it("rejects foreign bots", () => {
    expect(isJuniorMessage({ bot_id: "B_OTHER" }, "B_SELF", "U_BOT")).toBe(false);
  });

  it("rejects human users", () => {
    expect(isJuniorMessage({ user: "U_HUMAN" }, "B_SELF", "U_BOT")).toBe(false);
  });
});

describe("formatThreadArchiveMarkdown", () => {
  it("renders metadata and quoted messages", () => {
    const meta: ThreadArchiveMeta = {
      channelName: "tech-support",
      channelId: "C123",
      threadTs: "1716890123.456789",
      archivedAt: "2026-05-28T14:32:01.234Z",
      triggeredByUserId: "U_ADMIN",
      triggeredByUserName: "Admin",
      totalMessages: 2,
      juniorMessageCount: 1,
    };
    const messages: ArchivedMessage[] = [
      {
        ts: "1716890123.456789",
        roleLabel: "User(Alice <@U1>)",
        text: "hello",
        isJunior: false,
        timestampUtc: "2026-05-28 14:01:02 UTC",
      },
      {
        ts: "1716890124.123456",
        roleLabel: "Junior",
        text: "on it",
        isJunior: true,
        timestampUtc: "2026-05-28 14:01:15 UTC",
      },
    ];

    const md = formatThreadArchiveMarkdown(meta, messages);
    expect(md).toContain("# Thread archive");
    expect(md).toContain("| Channel | #tech-support (C123) |");
    expect(md).toContain("**User(Alice <@U1>)**");
    expect(md).toContain("> hello");
    expect(md).toContain("**Junior**");
    expect(md).toContain("> on it");
  });
});

describe("fetchFullThreadReplies", () => {
  it("paginates until cursor is exhausted", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      conversations: {
        replies: async (args: Record<string, unknown>) => {
          calls.push(args);
          if (!args.cursor) {
            return {
              messages: [{ ts: "1.0", user: "U1", text: "first" }],
              response_metadata: { next_cursor: "cursor-2" },
            };
          }
          return {
            messages: [{ ts: "2.0", user: "U2", text: "second" }],
            response_metadata: {},
          };
        },
      },
    };

    const messages = await fetchFullThreadReplies(
      client as never,
      "C123",
      "1.0",
    );

    expect(calls).toHaveLength(2);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.ts).toBe("1.0");
    expect(messages[1]?.ts).toBe("2.0");
  });
});

describe("deleteJuniorMessages", () => {
  it("reports delete failures separately from successful deletes", async () => {
    const client = {
      chat: {
        delete: async ({ ts }: { ts: string }) => {
          if (ts === "101.0") throw new Error("cant_delete_message");
        },
      },
    };

    const result = await deleteJuniorMessages(
      client as never,
      "C123",
      [
        { ts: "100.0", bot_id: "B_SELF" },
        { ts: "101.0", bot_id: "B_SELF" },
        { ts: "102.0", user: "U_HUMAN" },
      ],
      "B_SELF",
      "U_BOT",
    );

    expect(result).toEqual({ deletedCount: 1, failedCount: 1 });
  });
});
