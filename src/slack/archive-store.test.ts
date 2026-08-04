import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SlackArchiveStore } from "./archive-store.ts";
import type { SlackArchiveMessageInput } from "./archive-types.ts";

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
    store = new SlackArchiveStore(":memory:");
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
});
