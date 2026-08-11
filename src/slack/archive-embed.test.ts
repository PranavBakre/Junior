import { describe, expect, test } from "bun:test";
import type { EmbeddingProvider, EmbedMode } from "../memory/embedding/types.ts";
import { embedSlackArchive } from "./archive-embed.ts";
import { retrySqliteBusy, SlackArchiveStore } from "./archive-store.ts";
import type { SlackArchiveMessageInput } from "./archive-types.ts";

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = "fake-embed";
  readonly dim = 2;
  calls: Array<{ texts: string[]; mode: EmbedMode }> = [];
  failAtCall: number | null = null;
  beforeCall?: (texts: string[]) => void;

  async embed(texts: string[], mode: EmbedMode): Promise<Float32Array[]> {
    this.calls.push({ texts, mode });
    this.beforeCall?.(texts);
    if (this.failAtCall === this.calls.length) throw new Error("interrupted");
    return texts.map((text) => new Float32Array([text.length, 1]));
  }
}

function message(ts: string, text: string, observedAt = 1): SlackArchiveMessageInput {
  return {
    channelId: "C1",
    ts,
    text,
    embedding: null,
    ingestSource: "backfill",
    observedAt,
  };
}

describe("embedSlackArchive", () => {
  test("persists completed batches and resumes idempotently after interruption", async () => {
    const store = new SlackArchiveStore(":memory:", { vectorDimensions: 2 });
    try {
      store.upsertMessages([
        message("1.000001", "one"),
        message("2.000001", "two"),
        message("3.000001", "three"),
      ]);
      const interrupted = new FakeEmbeddingProvider();
      interrupted.failAtCall = 2;
      await expect(embedSlackArchive({
        store,
        provider: interrupted,
        dryRun: false,
        batchSize: 2,
      })).rejects.toThrow("interrupted");

      expect(store.getMessage("C1", "1.000001")?.embedding).not.toBeNull();
      expect(store.getMessage("C1", "2.000001")?.embedding).not.toBeNull();
      expect(store.getMessage("C1", "3.000001")?.embedding).toBeNull();

      const resumed = new FakeEmbeddingProvider();
      const report = await embedSlackArchive({ store, provider: resumed, dryRun: false, batchSize: 2 });
      expect(report).toMatchObject({ initialPending: 1, embedded: 1, remaining: 0 });
      expect(resumed.calls).toEqual([{ texts: ["three"], mode: "document" }]);

      const idempotent = await embedSlackArchive({ store, provider: resumed, dryRun: false });
      expect(idempotent).toMatchObject({ initialPending: 0, embedded: 0, batches: 0 });
      expect(resumed.calls).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("dry-run reports pending metadata without embedding and skips empty text", async () => {
    const store = new SlackArchiveStore(":memory:", { vectorDimensions: 2 });
    try {
      store.upsertMessages([
        message("1.000001", "meaningful"),
        message("2.000001", ""),
        message("3.000001", "  \n\t"),
      ]);
      const provider = new FakeEmbeddingProvider();
      const report = await embedSlackArchive({ store, provider });
      expect(report).toMatchObject({
        dryRun: true,
        initialPending: 1,
        emptyTextSkipped: 2,
        embedded: 0,
      });
      expect(provider.calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("does not attach a vector to text changed while embedding", async () => {
    const store = new SlackArchiveStore(":memory:", { vectorDimensions: 2 });
    try {
      store.upsertMessage(message("1.000001", "old text"));
      const provider = new FakeEmbeddingProvider();
      let edited = false;
      provider.beforeCall = (texts) => {
        if (!edited && texts[0] === "old text") {
          edited = true;
          store.upsertMessage(message("1.000001", "new text", 2));
        }
      };

      const report = await embedSlackArchive({ store, provider, dryRun: false, batchSize: 1 });
      expect(report).toMatchObject({ embedded: 1, staleSkipped: 1, remaining: 0 });
      expect(provider.calls.map((call) => call.texts)).toEqual([["old text"], ["new text"]]);
      expect([...store.getMessage("C1", "1.000001")!.embedding!]).toEqual([8, 1]);
    } finally {
      store.close();
    }
  });

  test("retries transient SQLITE_BUSY failures with a bound", () => {
    let attempts = 0;
    const result = retrySqliteBusy(() => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("database is locked") as Error & { code: string };
        error.code = "SQLITE_BUSY";
        throw error;
      }
      return "ok";
    }, { attempts: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});
