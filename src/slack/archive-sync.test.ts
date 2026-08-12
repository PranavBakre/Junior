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

  getThreadSyncState(
    channelId: string,
  ): Map<string, { latestTs: string; hasRoot: boolean }> {
    const state = new Map<string, { latestTs: string; hasRoot: boolean }>();
    for (const message of this.messages.values()) {
      if (message.channelId !== channelId) continue;
      const threadTs = message.threadTs ?? message.ts;
      const current = state.get(threadTs);
      state.set(threadTs, {
        latestTs: !current || message.ts > current.latestTs ? message.ts : current.latestTs,
        hasRoot: current?.hasRoot === true || message.ts === threadTs,
      });
    }
    return state;
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

    const result = await new SlackArchiveSync({
      client,
      store,
      pageSize: 2,
      approvedChannelIds: new Set(["D2"]),
    }).sync();

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
    const historyCalls: Record<string, unknown>[] = [];
    const client = fakeClient({
      history: async (args) => {
        historyCalls.push(args);
        return {
          ok: true,
          messages: [messageInput("21.000001", "new"), messageInput("20.000001", "backfill copy")],
        };
      },
    });

    await new SlackArchiveSync({ client, store }).sync();

    expect(historyCalls[0]).toMatchObject({ oldest: "20.000001", inclusive: true });
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

  it("keeps the history checkpoint in the root-message timestamp domain", async () => {
    const store = new MemoryStore();
    const client = fakeClient({
      history: async () => ({
        ok: true,
        messages: [{ ts: "100.000001", text: "root", reply_count: 1 }],
      }),
      replies: async () => ({
        ok: true,
        messages: [
          { ts: "100.000001", text: "root" },
          { ts: "200.000001", thread_ts: "100.000001", text: "reply" },
        ],
      }),
    });
    await new SlackArchiveSync({ client, store }).sync();
    expect(store.checkpoints.get("C1")).toBe("100.000001");
  });

  it("repairs replies on roots older than the channel history checkpoint", async () => {
    const store = new MemoryStore();
    store.checkpoints.set("C1", "200.000001");
    const replyRoots: string[] = [];
    const client = fakeClient({
      history: async (args) => args.oldest
        ? { ok: true, messages: [] }
        : {
            ok: true,
            messages: [{
              ts: "100.000001",
              text: "old root",
              reply_count: 1,
              latest_reply: "250.000001",
            }],
          },
      replies: async ({ ts }) => {
        replyRoots.push(ts);
        return {
          ok: true,
          messages: [
            { ts, text: "old root" },
            { ts: "250.000001", thread_ts: ts, text: "missed reply" },
          ],
        };
      },
    });
    await new SlackArchiveSync({ client, store }).sync();
    expect(replyRoots).toEqual(["100.000001"]);
    expect(store.messages.get("C1:250.000001")?.text).toBe("missed reply");
    expect(store.checkpoints.get("C1")).toBe("200.000001");
  });

  it("recovers a root skipped by a legacy reply-based checkpoint", async () => {
    const store = new MemoryStore();
    store.checkpoints.set("C1", "300.000001");
    const client = fakeClient({
      history: async (args) => args.oldest
        ? { ok: true, messages: [] }
        : { ok: true, messages: [{ ts: "200.000001", text: "skipped root" }] },
    });
    await new SlackArchiveSync({ client, store }).sync();
    expect(store.messages.get("C1:200.000001")?.text).toBe("skipped root");
  });

  it("recovers a missing root when a later reply was already captured live", async () => {
    const store = new MemoryStore();
    store.checkpoints.set("C1", "300.000001");
    store.upsertMessage({
      channelId: "C1",
      ts: "250.000001",
      threadTs: "200.000001",
      text: "captured reply",
    });
    const client = fakeClient({
      history: async (args) => args.oldest
        ? { ok: true, messages: [] }
        : {
            ok: true,
            messages: [{
              ts: "200.000001",
              text: "missing root",
              reply_count: 1,
              latest_reply: "250.000001",
            }],
          },
    });
    await new SlackArchiveSync({ client, store }).sync();
    expect(store.messages.get("C1:200.000001")?.text).toBe("missing root");
  });

  it("skips non-public conversations unless explicitly approved", async () => {
    const store = new MemoryStore();
    const historyChannels: string[] = [];
    const client = fakeClient({
      list: async () => ({
        ok: true,
        channels: [
          { id: "C1", name: "public", is_channel: true },
          { id: "G1", name: "private", is_private: true },
          { id: "D1", is_im: true },
        ],
      }),
      history: async ({ channel }) => {
        historyChannels.push(channel);
        return { ok: true, messages: [] };
      },
    });
    await new SlackArchiveSync({ client, store }).sync();
    expect(historyChannels).toEqual(["C1"]);
  });

  it("joins visible public channels before reading their history", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      list: async () => ({
        ok: true,
        channels: [{ id: "C_PUBLIC", name: "general", is_channel: true, is_member: false }],
        response_metadata: { next_cursor: "" },
      }),
      join: async ({ channel }) => {
        calls.push(`join:${channel}`);
        return { ok: true };
      },
      history: async ({ channel }) => {
        calls.push(`history:${channel}`);
        return { ok: true, messages: [], response_metadata: { next_cursor: "" } };
      },
    });

    await new SlackArchiveSync({ client, store: new MemoryStore() }).sync();

    expect(calls).toEqual(["join:C_PUBLIC", "history:C_PUBLIC"]);
  });
});

function fakeClient(overrides: {
  list?: SlackArchiveClient["conversations"]["list"];
  join?: SlackArchiveClient["conversations"]["join"];
  history?: SlackArchiveClient["conversations"]["history"];
  replies?: SlackArchiveClient["conversations"]["replies"];
}): SlackArchiveClient {
  return {
    conversations: {
      list: overrides.list ?? (async () => ({
        ok: true,
        channels: [{ id: "C1", name: "general", is_channel: true }],
      })),
      ...(overrides.join ? { join: overrides.join } : {}),
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
