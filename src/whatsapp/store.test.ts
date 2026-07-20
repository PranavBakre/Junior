import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WhatsAppStore } from "./store.ts";
import type { WaMessageInput } from "./types.ts";

function makeStore(): WhatsAppStore {
  // In-memory DB — isolated per test, no filesystem, no cleanup needed.
  return new WhatsAppStore(":memory:");
}

function msg(overrides: Partial<WaMessageInput> = {}): WaMessageInput {
  return {
    id: "msg-1",
    groupJid: "123@g.us",
    groupName: "Hermes Bangalore",
    senderJid: "999@s.whatsapp.net",
    senderName: "Alice",
    ts: 1000,
    text: "hello",
    replyToId: null,
    raw: null,
    ...overrides,
  };
}

describe("WhatsAppStore messages", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("upsertMessage persists and getMessage returns it", () => {
    store.upsertMessage(msg());
    expect(store.getMessage("msg-1")).toMatchObject({
      id: "msg-1",
      groupJid: "123@g.us",
      senderName: "Alice",
      text: "hello",
    });
  });

  test("upsertMessage dedupes on id without clobbering the original", () => {
    store.upsertMessage(msg({ text: "original" }));
    store.upsertMessage(msg({ text: "duplicate" }));
    expect(store.getMessage("msg-1")?.text).toBe("original");
    expect(store.getMessages({ limit: 10 })).toHaveLength(1);
  });

  test("getMessage returns undefined for unknown ids", () => {
    expect(store.getMessage("nope")).toBeUndefined();
  });
});

describe("WhatsAppStore.getMessages", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
    store.upsertMessage(msg({ id: "a", ts: 100, text: "first" }));
    store.upsertMessage(msg({ id: "b", ts: 200, text: "second" }));
    store.upsertMessage(msg({ id: "c", ts: 300, text: "third" }));
    store.upsertMessage(
      msg({ id: "d", ts: 250, groupJid: "456@g.us", groupName: "Other", text: "elsewhere" }),
    );
  });
  afterEach(() => {
    store.close();
  });

  test("returns the newest window in chronological order", () => {
    const rows = store.getMessages({ limit: 2 });
    expect(rows.map((r) => r.id)).toEqual(["d", "c"]);
  });

  test("scopes to a group", () => {
    const rows = store.getMessages({ groupJid: "123@g.us", limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("beforeTs pages backwards exclusively", () => {
    const rows = store.getMessages({ groupJid: "123@g.us", beforeTs: 300, limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("beforeTs + beforeId page through same-second messages without loss", () => {
    // Three messages sharing one timestamp — timestamp-only paging would strand
    // whichever ones a page boundary splits off.
    store.upsertMessage(msg({ id: "t1", ts: 500 }));
    store.upsertMessage(msg({ id: "t2", ts: 500 }));
    store.upsertMessage(msg({ id: "t3", ts: 500 }));
    const seen: string[] = [];
    let cursor: { beforeTs?: number; beforeId?: string } = {};
    for (;;) {
      const page = store.getMessages({ groupJid: "123@g.us", ...cursor, limit: 1 });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id));
      cursor = { beforeTs: page[0]!.ts, beforeId: page[0]!.id };
    }
    expect(seen).toEqual(["t3", "t2", "t1", "c", "b", "a"]);
  });

  test("afterTs is inclusive", () => {
    const rows = store.getMessages({ groupJid: "123@g.us", afterTs: 200, limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("WhatsAppStore.listGroups", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("summarises per group, most recently active first", () => {
    store.upsertMessage(msg({ id: "a", ts: 100 }));
    store.upsertMessage(msg({ id: "b", ts: 300 }));
    store.upsertMessage(
      msg({ id: "c", ts: 200, groupJid: "456@g.us", groupName: "Other" }),
    );
    expect(store.listGroups()).toEqual([
      {
        groupJid: "123@g.us",
        groupName: "Hermes Bangalore",
        messageCount: 2,
        firstTs: 100,
        lastTs: 300,
      },
      {
        groupJid: "456@g.us",
        groupName: "Other",
        messageCount: 1,
        firstTs: 200,
        lastTs: 200,
      },
    ]);
  });

  test("prefers the newest non-null subject (renames win)", () => {
    store.upsertMessage(msg({ id: "a", ts: 100, groupName: "Old Name" }));
    store.upsertMessage(msg({ id: "b", ts: 200, groupName: "New Name" }));
    store.upsertMessage(msg({ id: "c", ts: 300, groupName: null }));
    expect(store.listGroups()[0]?.groupName).toBe("New Name");
  });

  test("same-second rename resolves deterministically to the later-ingested subject", () => {
    // WhatsApp timestamps are whole seconds — a rename adjacent to activity
    // produces different subjects on the same ts. Insertion order breaks the
    // tie so the last-captured subject wins instead of an arbitrary row.
    store.upsertMessage(msg({ id: "z-first", ts: 100, groupName: "Before Rename" }));
    store.upsertMessage(msg({ id: "a-second", ts: 100, groupName: "After Rename" }));
    expect(store.listGroups()[0]?.groupName).toBe("After Rename");
  });
});

describe("WhatsAppStore.searchMessages", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
    store.upsertMessage(msg({ id: "a", ts: 100, text: "deploy the API tonight" }));
    store.upsertMessage(msg({ id: "b", ts: 200, text: "Deploy done ✅" }));
    store.upsertMessage(
      msg({ id: "c", ts: 300, text: "lunch plans?", senderName: "Bob", senderJid: "111@s.whatsapp.net" }),
    );
    store.upsertMessage(
      msg({ id: "d", ts: 400, groupJid: "456@g.us", groupName: "Other", text: "deploy elsewhere" }),
    );
  });
  afterEach(() => {
    store.close();
  });

  async function search(q: Parameters<WhatsAppStore["searchMessages"]>[0]) {
    return (await store.searchMessages(q)).matches;
  }

  test("matches case-insensitively, newest first", async () => {
    const rows = await search({ query: "deploy", limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(["d", "b", "a"]);
  });

  test("scopes to a group", async () => {
    const rows = await search({ query: "deploy", groupJid: "123@g.us", limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  test("filters by sender name or JID substring", async () => {
    expect(await search({ query: "lunch", sender: "bob", limit: 10 })).toHaveLength(1);
    expect(await search({ query: "lunch", sender: "111@", limit: 10 })).toHaveLength(1);
    expect(await search({ query: "lunch", sender: "alice", limit: 10 })).toHaveLength(0);
  });

  test("treats % and _ as literals, not wildcards", async () => {
    store.upsertMessage(msg({ id: "pct", ts: 500, text: "we hit 100% coverage" }));
    expect((await search({ query: "100%", limit: 10 })).map((r) => r.id)).toEqual(["pct"]);
    // A bare % must not act as a wildcard matching everything.
    expect(await search({ query: "0%c", limit: 10 })).toHaveLength(0);
  });

  test("case-folds non-ASCII text (beyond SQLite's ASCII-only LIKE)", async () => {
    store.upsertMessage(msg({ id: "fr", ts: 600, text: "rendez-vous à l'École" }));
    expect((await search({ query: "école", limit: 10 })).map((r) => r.id)).toEqual(["fr"]);
  });

  test("honors the limit", async () => {
    expect(await search({ query: "deploy", limit: 2 })).toHaveLength(2);
  });

  test("scans past a non-matching batch boundary and reports a complete scan", async () => {
    // 600+ filler rows newer than the match force the scan into a second batch.
    for (let i = 0; i < 620; i++) {
      store.upsertMessage(msg({ id: `filler-${i}`, ts: 1000 + i, text: "noise" }));
    }
    const empty = await store.searchMessages({ query: "kickoff", limit: 10 });
    expect(empty.matches).toHaveLength(0);
    expect(empty.scannedAll).toBe(true);
    store.upsertMessage(msg({ id: "old", ts: 50, text: "kickoff notes" }));
    expect((await search({ query: "kickoff", limit: 10 })).map((r) => r.id)).toEqual(["old"]);
  });
});
