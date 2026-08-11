import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSlackArchiveVectorIndex } from "./archive-index.ts";
import { SlackArchiveStore } from "./archive-store.ts";

describe("Slack archive HNSW index", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("publishes a persisted full-history vector index searchable after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "junior-slack-index-"));
    directories.push(directory);
    const dbPath = join(directory, "archive.db");
    const indexPath = `${dbPath}.usearch`;
    const writer = new SlackArchiveStore(dbPath, { vectorDimensions: 2 });
    writer.upsertMessages([
      {
        channelId: "C_OLD",
        ts: "1000000000.000001",
        text: "old semantic target",
        embedding: new Float32Array([1, 0]),
        embedModel: "test",
        dim: 2,
      },
      {
        channelId: "C_NEW",
        ts: "2000000000.000001",
        text: "new unrelated message",
        embedding: new Float32Array([0, 1]),
        embedModel: "test",
        dim: 2,
      },
    ]);
    writer.close();

    const reader = new SlackArchiveStore(dbPath, { readonly: true, vectorDimensions: 2 });
    const report = buildSlackArchiveVectorIndex({
      store: reader,
      indexPath,
      dimensions: 2,
      batchSize: 1,
    });
    reader.close();
    expect(report.indexed).toBe(2);

    const searcher = new SlackArchiveStore(dbPath, {
      readonly: true,
      vectorDimensions: 2,
      vectorIndexPath: indexPath,
    });
    const [hit] = searcher.search({
      queryVector: new Float32Array([1, 0]),
      limit: 1,
    });
    expect(hit?.message.text).toBe("old semantic target");
    expect(hit?.vectorRank).toBe(1);
    searcher.close();
  });
});

