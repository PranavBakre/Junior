import { describe, expect, it } from "bun:test";
import {
  SlackArchiveSync,
  type ArchiveSyncStore,
  type SlackArchiveClient,
  type SlackArchiveConversation,
  type SlackArchiveMessageInput,
} from "./archive-sync.ts";

class MemoryStore implements ArchiveSyncStore {
  readonly messages = new Map<string, SlackArchiveMessageInput>();
  readonly checkpoints = new Map<string, string>();
  readonly conversations: SlackArchiveConversation[] = [];

  getCheckpoint(channelId: string): string | undefined {
    return this.checkpoints.get(channelId);
  }

  setCheckpoint(channelId: string, ts: string): void {
    this.checkpoints.set(channelId, ts);
  }

  upsertMessage(message: SlackArchiveMessageInput): void {
    this.messages.set(`${message.channelId}:${message.ts}`, message);
  }

  upsertConversation(conversation: SlackArchiveConversation): void {
    this.conversations.push(conversation);
  }
}

describe("SlackArchiveSync", () => {
  it("paginates conversations and history and writes messages chronologically", async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const client = fakeClient({
      list: async ({ cursor }) => {
        calls.push(`list:${cursor ?? ""}`);
        return cursor
          ? { ok: true, channels: [{ id: "D2", is_im: true }] }
          : {
              ok: true,
              channels: [{ id: "C1", name: "general", is_channel: true }],
              response_metadata: { next_cursor: "next-channels" },
            };
      },
      history: async ({ channel, cursor }) => {
        calls.push(`history:${channel}:${cursor ?? ""}`);
        if (channel === "D2") return { ok: true, messages: [] };
        return cursor
          ? { ok: true, messages: [{ ts: "1.000001", text: "first" }] }
          : {
              ok: true,
              messages: [{ ts: "3.000001", text: "third" }, { ts: "2.000001", text: "second" }],
              response_metadata: { next_cursor: "next-history" },
            };
      },
    });

    const result = await new SlackArchiveSync({ client, store, pageSize: 2 }).sync();

    expect(result).toEqual({ channels: 2, messages: 3 });
    expect(calls).toEqual([
      "list:",
      "history:C1:",
      "history:C1:next-history",
      "list:next-channels",
      "history:D2:",
    ]);
    expect([...store.messages.values()].map((message) => message.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(store.checkpoints.get("C1")).toBe("3.000001");
  });

  it("paginates replies, dedupes their repeated root, and canonicalizes files", async () => {
    const store = new MemoryStore();
    const replyCursors: Array<string | undefined> = [];
    const client = fakeClient({
      history: async () => ({
        ok: true,
        messages: [{ ts: "10.000001", text: "root", reply_count: 2 }],
      }),
      replies: async ({ cursor }) => {
        replyCursors.push(cursor);
        return cursor
          ? {
              ok: true,
              messages: [{
                ts: "12.000001",
                thread_ts: "10.000001",
                bot_id: "B1",
                files: [{ id: "F1", name: "report.pdf", url_private: "https://files/1" }],
              }],
            }
          : {
              ok: true,
              messages: [
                { ts: "10.000001", text: "root" },
                { ts: "11.000001", thread_ts: "10.000001", user: "U1", text: "reply" },
              ],
              response_metadata: { next_cursor: "more-replies" },
            };
      },
    });

    await new SlackArchiveSync({ client, store }).sync();

    expect(replyCursors).toEqual([undefined, "more-replies"]);
    expect(store.messages.size).toBe(3);
    expect(store.messages.get("C1:11.000001")?.threadTs).toBe("10.000001");
    expect(store.messages.get("C1:12.000001")?.files?.[0]).toEqual({
      id: "F1",
      name: "report.pdf",
      title: null,
      mimetype: null,
      filetype: null,
      size: null,
      urlPrivate: "https://files/1",
      permalink: null,
    });
  });

  it("uses an inclusive checkpoint so live and backfill overlap idempotently", async () => {
    const store = new MemoryStore();
    store.checkpoints.set("C1", "20.000001");
    store.upsertMessage(message("20.000001", "live copy"));
    let historyArgs: Record<string, unknown> | undefined;
    const client = fakeClient({
      history: async (args) => {
        historyArgs = args;
        return {
          ok: true,
          messages: [messageInput("21.000001", "new"), messageInput("20.000001", "backfill copy")],
        };
      },
    });

    await new SlackArchiveSync({ client, store }).sync();

    expect(historyArgs).toMatchObject({ oldest: "20.000001", inclusive: true });
    expect(store.messages.size).toBe(2);
    expect(store.messages.get("C1:20.000001")?.text).toBe("backfill copy");
    expect(store.checkpoints.get("C1")).toBe("21.000001");
  });

  it("resumes from its channel checkpoint", async () => {
    const store = new MemoryStore();
    store.checkpoints.set("C1", "50.000001");
    const oldest: Array<string | undefined> = [];
    const client = fakeClient({
      history: async (args) => {
        oldest.push(args.oldest);
        return { ok: true, messages: [{ ts: "51.000001", text: "next" }] };
      },
    });

    await new SlackArchiveSync({ client, store }).sync();

    expect(oldest).toEqual(["50.000001"]);
    expect(store.checkpoints.get("C1")).toBe("51.000001");
  });

  it("does not advance a checkpoint when a later history page fails", async () => {
    const store = new MemoryStore();
    store.checkpoints.set("C1", "70.000001");
    const client = fakeClient({
      history: async ({ cursor }) => cursor
        ? { ok: false, error: "ratelimited" }
        : {
            ok: true,
            messages: [{ ts: "71.000001", text: "partially stored" }],
            response_metadata: { next_cursor: "will-fail" },
          },
    });

    await expect(new SlackArchiveSync({ client, store }).sync()).rejects.toThrow(
      "conversations.history failed: ratelimited",
    );
    expect(store.messages.has("C1:71.000001")).toBe(false);
    expect(store.checkpoints.get("C1")).toBe("70.000001");
  });
});

function fakeClient(overrides: {
  list?: SlackArchiveClient["conversations"]["list"];
  history?: SlackArchiveClient["conversations"]["history"];
  replies?: SlackArchiveClient["conversations"]["replies"];
}): SlackArchiveClient {
  return {
    conversations: {
      list: overrides.list ?? (async () => ({
        ok: true,
        channels: [{ id: "C1", name: "general", is_channel: true }],
      })),
      history: overrides.history ?? (async () => ({ ok: true, messages: [] })),
      replies: overrides.replies ?? (async () => ({ ok: true, messages: [] })),
    },
  };
}

function messageInput(ts: string, text: string): { ts: string; text: string } {
  return { ts, text };
}

function message(ts: string, text: string): SlackArchiveMessageInput {
  return {
    channelId: "C1",
    channelName: "general",
    ts,
    threadTs: ts,
    userId: "U1",
    botId: null,
    actorId: "U1",
    actorKind: "human",
    subtype: null,
    text,
    files: [],
    embedding: null,
    ingestSource: "live",
  };
}
