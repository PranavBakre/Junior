import { describe, expect, it } from "bun:test";
import {
  importSlackArchive,
  type SlackArchiveImportStore,
  type SlackExportReader,
} from "./archive-import.ts";
import type {
  SlackArchiveConversation,
  SlackArchiveMessageInput,
  SlackArchiveWriteResult,
} from "./archive-types.ts";

class FakeReader implements SlackExportReader {
  constructor(private readonly entries: Record<string, unknown>) {}

  async listEntries(): Promise<string[]> {
    return Object.keys(this.entries);
  }

  async readJson(entry: string): Promise<unknown> {
    if (!(entry in this.entries)) throw new Error(`missing ${entry}`);
    return this.entries[entry];
  }
}

class ImportStore implements SlackArchiveImportStore {
  readonly messages = new Map<string, SlackArchiveMessageInput>();
  readonly batchSizes: number[] = [];
  readonly checkpoints = new Map<string, string>();
  readonly conversations: SlackArchiveConversation[] = [];

  upsertMessages(messages: SlackArchiveMessageInput[]): SlackArchiveWriteResult[] {
    this.batchSizes.push(messages.length);
    return messages.map((message) => {
      const key = `${message.channelId}:${message.ts}`;
      const result = this.messages.has(key) ? "deduped" : "inserted";
      this.messages.set(key, message);
      return result;
    });
  }

  setCheckpoint(channelId: string, latestTs: string): void {
    this.checkpoints.set(channelId, latestTs);
  }

  upsertConversation(conversation: SlackArchiveConversation): void {
    this.conversations.push(conversation);
  }
}

describe("importSlackArchive", () => {
  it("maps channel and user manifests, preserves metadata, and writes bounded batches", async () => {
    const store = new ImportStore();
    const reader = new FakeReader({
      "channels.json": [{ id: "C123", name: "general" }],
      "users.json": [{
        id: "U1",
        name: "alice",
        profile: { display_name: "Alice Example" },
      }],
      "general/2026-08-03.json": [
        { type: "message", ts: "3.000001", user: "U1", text: "third" },
      ],
      "general/2026-08-04.json": [
        { type: "message", ts: "4.000001", user: "U1", text: "fourth" },
        {
          type: "message",
          ts: "5.000001",
          thread_ts: "4.000001",
          subtype: "bot_message",
          bot_id: "B1",
          app_id: "A1",
          username: "Junior",
          text: "reply",
          files: [{ id: "F1", name: "result.csv", mimetype: "text/csv" }],
        },
      ],
    });

    const report = await importSlackArchive({ reader, store, batchSize: 2 });

    expect(report).toMatchObject({
      dryRun: false,
      channels: 1,
      files: 2,
      messagesSeen: 3,
      messagesValid: 3,
      inserted: 3,
      checkpoints: 1,
    });
    expect(store.batchSizes).toEqual([2, 1]);
    expect(store.conversations).toEqual([{ id: "C123", name: "general", kind: "public_channel" }]);
    expect(store.messages.get("C123:3.000001")).toMatchObject({
      actorId: "U1",
      actorName: "Alice Example",
      actorKind: "human",
      ingestSource: "backfill",
      embedding: null,
    });
    expect(store.messages.get("C123:5.000001")).toMatchObject({
      threadTs: "4.000001",
      actorId: "B1",
      actorName: "Junior",
      actorKind: "bot",
      metadata: { appId: "A1", botUsername: "Junior" },
      files: [{ id: "F1", name: "result.csv", mimetype: "text/csv" }],
    });
    expect(store.checkpoints.get("C123")).toBe("5.000001");
  });

  it("dry-runs the whole archive without writes or embeddings", async () => {
    const store = new ImportStore();
    const report = await importSlackArchive({
      reader: simpleReader(),
      store,
      dryRun: true,
    });

    expect(report).toMatchObject({ dryRun: true, messagesSeen: 2, messagesValid: 2 });
    expect(store.messages.size).toBe(0);
    expect(store.conversations).toEqual([]);
    expect(store.checkpoints.size).toBe(0);
  });

  it("is idempotent when the same export overlaps an existing archive", async () => {
    const store = new ImportStore();

    const first = await importSlackArchive({ reader: simpleReader(), store });
    const second = await importSlackArchive({ reader: simpleReader(), store });

    expect(first.inserted).toBe(2);
    expect(second.deduped).toBe(2);
    expect(store.messages.size).toBe(2);
    expect(store.checkpoints.get("C1")).toBe("2.000001");
  });

  it("does not mark a channel complete when a batch write fails", async () => {
    const store = new ImportStore();
    store.upsertMessages = () => {
      throw new Error("disk full");
    };

    await expect(importSlackArchive({ reader: simpleReader(), store, batchSize: 1 })).rejects.toThrow(
      "disk full",
    );
    expect(store.checkpoints.size).toBe(0);
  });
});

function simpleReader(): SlackExportReader {
  return new FakeReader({
    "channels.json": [{ id: "C1", name: "general" }],
    "users.json": [],
    "general/2026-08-04.json": [
      { type: "message", ts: "1.000001", text: "one" },
      { type: "message", ts: "2.000001", text: "two" },
    ],
  });
}
