import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackArchiveStore } from "./archive-store.ts";
import type { SlackArchiveMessageInput } from "./archive-types.ts";
import type { SlackArchiveVectorSearcher } from "./archive-vector-index.ts";

function message(overrides: Partial<SlackArchiveMessageInput> = {}): SlackArchiveMessageInput {
  return {
    channelId: "C1",
    channelName: "engineering",
    ts: "1700000000.000100",
    threadTs: "1700000000.000100",
    userId: "U1",
    actorId: "U1",
    actorName: "Alice",
    actorKind: "human",
    text: "deploy the payments service",
    files: [],
    embedding: new Float32Array([1, 0]),
    embedModel: "test",
    ingestSource: "backfill",
    observedAt: 100,
    ...overrides,
  };
}

describe("SlackArchiveStore", () => {
  let store: SlackArchiveStore;

  beforeEach(() => {
    store = new SlackArchiveStore(":memory:", { vectorDimensions: 2 });
  });
  afterEach(() => store.close());

  test("uses channel + ts identity and rejects stale backfill over live data", () => {
    expect(store.upsertMessage(message({ text: "live edit", ingestSource: "live", observedAt: 200 })))
      .toBe("inserted");
    expect(store.upsertMessage(message({ text: "old backfill", observedAt: 100 }))).toBe("deduped");
    expect(store.getMessage("C1", "1700000000.000100")?.text).toBe("live edit");
    store.upsertMessage(message({ channelId: "C2" }));
    expect(store.getMessage("C2", "1700000000.000100")).not.toBeNull();
  });

  test("reports an identical stable backfill replay as deduped", () => {
    expect(store.upsertMessage(message())).toBe("inserted");
    expect(store.upsertMessage(message())).toBe("deduped");
  });

  test("preserves a vector on replay but invalidates it on a text edit", () => {
    store.upsertMessage(message());
    store.upsertMessage(message({ embedding: null, observedAt: 101 }));
    expect([...store.getMessage("C1", "1700000000.000100")!.embedding!]).toEqual([1, 0]);
    store.upsertMessage(message({ text: "edited body", embedding: null, observedAt: 102 }));
    expect(store.getMessage("C1", "1700000000.000100")?.embedding).toBeNull();
  });

  test("searches FTS5 with channel, actor, and time filters", () => {
    store.upsertMessage(message());
    store.upsertMessage(message({
      channelId: "C2",
      ts: "1700000100.000100",
      threadTs: "1700000100.000100",
      actorId: "U2",
      userId: "U2",
      actorName: "Bob",
      text: "deploy the website",
      observedAt: 101,
    }));
    const hits = store.search({
      queryText: "deploy",
      filters: { channelId: "C1", actorId: "U1", sinceMs: 1_699_999_999_000 },
      limit: 10,
    });
    expect(hits.map((hit) => hit.message.channelId)).toEqual(["C1"]);
  });

  test("accepts natural-language questions without requiring every token", () => {
    store.upsertMessage(message({ text: "Pranav approved the Atlas migration" }));
    const hits = store.search({ queryText: "what did Pranav decide about Atlas?" });
    expect(hits[0]?.message.text).toContain("Atlas migration");
  });

  test("fuses lexical and vector ranks", () => {
    store.upsertMessage(message({ text: "unrelated words" }));
    store.upsertMessage(message({
      ts: "1700000001.000100",
      threadTs: "1700000001.000100",
      text: "payments release",
      embedding: new Float32Array([0, 1]),
      observedAt: 101,
    }));
    const hits = store.search({ queryText: "payments", queryVector: new Float32Array([1, 0]) });
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.vectorRank !== null)).toBe(true);
    expect(hits.some((hit) => hit.lexicalRank !== null)).toBe(true);
  });

  test("expands a hit to bounded chronological thread context", () => {
    const root = "1700000000.000100";
    store.upsertMessage(message({ ts: root, threadTs: root, text: "incident root" }));
    store.upsertMessage(message({ ts: "1700000002.000100", threadTs: root, text: "second", observedAt: 102 }));
    store.upsertMessage(message({ ts: "1700000001.000100", threadTs: root, text: "first", observedAt: 101 }));
    const [hit] = store.search({ queryText: "incident", expandThreads: true, threadLimit: 2 });
    expect(hit?.thread?.map((entry) => entry.ts)).toEqual([root, "1700000001.000100"]);
  });

  test("persists and clears sync checkpoints", () => {
    expect(store.getCheckpoint("C1")).toBeNull();
    store.setCheckpoint("C1", "1700000000.000100");
    expect(store.getCheckpoint("C1")).toBe("1700000000.000100");
    store.setCheckpoint({ scope: "C1", cursor: "1700000001.000100", metadata: { page: 2 } });
    expect(store.getCheckpointRecord("C1")?.metadata).toEqual({ page: 2 });
    store.clearCheckpoint("C1");
    expect(store.getCheckpoint("C1")).toBeNull();
  });

  test("rejects a persisted-index hit after the SQLite embedding was invalidated", () => {
    const staleIndex: SlackArchiveVectorSearcher = {
      size: 1,
      search: () => [{ rowid: 1, cosine: 1 }],
    };
    const indexedStore = new SlackArchiveStore(":memory:", {
      vectorDimensions: 2,
      vectorIndex: staleIndex,
    });
    try {
      indexedStore.upsertMessage(message());
      indexedStore.upsertMessage(message({
        text: "edited body",
        embedding: null,
        observedAt: 101,
      }));
      expect(indexedStore.search({ queryVector: new Float32Array([1, 0]) })).toEqual([]);
    } finally {
      indexedStore.close();
    }
  });

  test("rejects a persisted-index hit whose distance disagrees with a re-embedded edit", () => {
    const staleIndex: SlackArchiveVectorSearcher = {
      size: 1,
      search: () => [{ rowid: 1, cosine: 1 }],
    };
    const indexedStore = new SlackArchiveStore(":memory:", {
      vectorDimensions: 2,
      vectorIndex: staleIndex,
    });
    try {
      indexedStore.upsertMessage(message());
      indexedStore.upsertMessage(message({
        text: "edited and re-embedded body",
        embedding: new Float32Array([0, 1]),
        observedAt: 101,
      }));
      expect(indexedStore.search({ queryVector: new Float32Array([1, 0]) })).toEqual([]);
    } finally {
      indexedStore.close();
    }
  });

  test("adaptively expands ANN candidates until a filtered channel has enough hits", () => {
    const requests: number[] = [];
    const adaptiveIndex: SlackArchiveVectorSearcher = {
      size: 120,
      search: (_query, limit) => {
        requests.push(limit);
        return Array.from({ length: limit }, (_, index) => ({
          rowid: index + 1,
          cosine: 1,
        }));
      },
    };
    const indexedStore = new SlackArchiveStore(":memory:", {
      vectorDimensions: 2,
      vectorIndex: adaptiveIndex,
    });
    try {
      for (let index = 0; index < 120; index += 1) {
        indexedStore.upsertMessage(message({
          channelId: index === 119 ? "C_ALLOWED" : "C_OTHER",
          ts: `${1700000000 + index}.000100`,
          threadTs: `${1700000000 + index}.000100`,
          observedAt: index + 1,
        }));
      }
      const hits = indexedStore.search({
        queryVector: new Float32Array([1, 0]),
        filters: { channelId: "C_ALLOWED" },
        limit: 1,
      });
      expect(requests).toEqual([100, 120]);
      expect(hits.map((hit) => hit.message.channelId)).toEqual(["C_ALLOWED"]);
    } finally {
      indexedStore.close();
    }
  });
});

describe("SlackArchiveStore FTS rowids", () => {
  let tempDirectory: string;
  let dbPath: string;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "junior-slack-archive-"));
    dbPath = join(tempDirectory, "archive.db");
  });
  afterEach(() => rmSync(tempDirectory, { recursive: true, force: true }));

  test("keeps insert and update FTS rows aligned with message rowids", () => {
    const fileStore = new SlackArchiveStore(dbPath);
    expect(fileStore.upsertMessage(message())).toBe("inserted");
    expect(fileStore.search({ queryText: "payments" })).toHaveLength(1);

    expect(fileStore.upsertMessage(message({
      text: "rollback the billing release",
      observedAt: 101,
    }))).toBe("updated");
    expect(fileStore.search({ queryText: "payments" })).toHaveLength(0);
    expect(fileStore.search({ queryText: "billing" })[0]?.message.text)
      .toBe("rollback the billing release");
    fileStore.close();

    const db = new Database(dbPath, { readonly: true });
    const rows = db.query<{ message_rowid: number; fts_rowid: number }, []>(`
      SELECT m.rowid AS message_rowid, f.rowid AS fts_rowid
      FROM slack_archive_message AS m
      JOIN slack_archive_fts AS f ON f.channel_id = m.channel_id AND f.ts = m.ts
    `).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fts_rowid).toBe(rows[0]?.message_rowid);

    const plan = db.query<{ detail: string }, [number]>(
      "EXPLAIN QUERY PLAN DELETE FROM slack_archive_fts WHERE rowid = ?",
    ).all(rows[0]!.message_rowid).map((row) => row.detail);
    expect(plan.some((detail) => detail.includes("VIRTUAL TABLE INDEX 0:="))).toBe(true);
    expect(plan.some((detail) => /VIRTUAL TABLE INDEX 0:$/.test(detail))).toBe(false);
    db.close();
  });

  test("transactionally migrates a legacy unaligned FTS once and skips migration for readonly opens", () => {
    const seedStore = new SlackArchiveStore(dbPath);
    seedStore.upsertMessages([
      message(),
      message({
        ts: "1700000001.000100",
        threadTs: "1700000001.000100",
        text: "second searchable message",
        observedAt: 101,
      }),
    ]);
    seedStore.close();

    const legacyDb = new Database(dbPath);
    legacyDb.run("DELETE FROM slack_archive_schema_migration WHERE name = 'fts-rowid-v1'");
    legacyDb.run("DELETE FROM slack_archive_fts");
    legacyDb.run(`
      INSERT INTO slack_archive_fts(rowid, channel_id, ts, text, actor_name, channel_name)
      SELECT rowid + 1000, channel_id, ts, text, coalesce(actor_name, ''), coalesce(channel_name, '')
      FROM slack_archive_message
    `);
    legacyDb.close();

    const readonlyStore = new SlackArchiveStore(dbPath, { readonly: true });
    readonlyStore.close();
    const afterReadonly = new Database(dbPath, { readonly: true });
    expect(afterReadonly.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM slack_archive_schema_migration
      WHERE name = 'fts-rowid-v1'
    `).get()?.count).toBe(0);
    afterReadonly.close();

    const migratedStore = new SlackArchiveStore(dbPath);
    expect(migratedStore.search({ queryText: "searchable" })).toHaveLength(1);
    migratedStore.close();

    const reopenedStore = new SlackArchiveStore(dbPath);
    reopenedStore.close();
    const migratedDb = new Database(dbPath, { readonly: true });
    expect(migratedDb.query<{ count: number }, []>(`
      SELECT count(*) AS count
      FROM slack_archive_message AS m
      JOIN slack_archive_fts AS f ON f.rowid = m.rowid
    `).get()?.count).toBe(2);
    expect(migratedDb.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM slack_archive_schema_migration
      WHERE name = 'fts-rowid-v1'
    `).get()?.count).toBe(1);
    migratedDb.close();
  });
});
