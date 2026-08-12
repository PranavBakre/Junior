import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashingEmbeddingProvider } from "../memory/embedding/hashing.ts";
import { SlackArchiveVectorIndex } from "./archive-vector-index.ts";
import { runSlackArchiveMaintenance } from "./archive-maintenance.ts";
import type { SlackArchiveClient } from "./archive-sync.ts";

describe("runSlackArchiveMaintenance", () => {
  it("syncs Slack directly, embeds pending rows, and republishes only a changed index", async () => {
    const root = mkdtempSync(join(tmpdir(), "junior-slack-maintenance-"));
    const dbPath = join(root, "archive.db");
    const indexPath = `${dbPath}.usearch`;
    const client = fakeClient();
    const embedder = new HashingEmbeddingProvider(4);

    try {
      const first = await runSlackArchiveMaintenance({
        client,
        dbPath,
        indexPath,
        dimensions: 4,
        embedder,
      });
      expect(first).toMatchObject({
        channelsSynced: 1,
        messagesSeen: 1,
        embedded: 1,
        remaining: 0,
        indexed: 1,
        indexRebuilt: true,
      });
      expect(existsSync(indexPath)).toBe(true);
      expect(new SlackArchiveVectorIndex(4, { path: indexPath, load: true }).size).toBe(1);

      const second = await runSlackArchiveMaintenance({
        client,
        dbPath,
        indexPath,
        dimensions: 4,
        embedder,
      });
      expect(second.embedded).toBe(0);
      expect(second.indexed).toBe(1);
      expect(second.indexRebuilt).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fakeClient(): SlackArchiveClient {
  return {
    conversations: {
      list: async () => ({
        ok: true,
        channels: [{ id: "C_PUBLIC", name: "general", is_channel: true, is_member: true }],
        response_metadata: { next_cursor: "" },
      }),
      history: async (args) => ({
        ok: true,
        messages: args.oldest
          ? [{ ts: "100.000001", text: "A calm rollout needs a rollback checkpoint", user: "U1" }]
          : [{ ts: "100.000001", text: "A calm rollout needs a rollback checkpoint", user: "U1" }],
        response_metadata: { next_cursor: "" },
      }),
      replies: async () => ({ ok: true, messages: [], response_metadata: { next_cursor: "" } }),
    },
  };
}
