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

  test("upsertMessage persists and getUnprocessedMessagesForGroup returns it", () => {
    store.upsertMessage(msg());
    const unprocessed = store.getUnprocessedMessagesForGroup("123@g.us", 10);
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0]).toMatchObject({
      id: "msg-1",
      groupJid: "123@g.us",
      text: "hello",
      processed: false,
    });
  });

  test("upsertMessage dedupes by id (INSERT OR IGNORE)", () => {
    store.upsertMessage(msg({ text: "original" }));
    store.upsertMessage(msg({ text: "duplicate live event" }));
    const rows = store.getUnprocessedMessagesForGroup("123@g.us", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("original");
  });

  test("getUnprocessedMessagesForGroup orders oldest-first and honors limit", () => {
    store.upsertMessage(msg({ id: "b", ts: 2000 }));
    store.upsertMessage(msg({ id: "a", ts: 1000 }));
    store.upsertMessage(msg({ id: "c", ts: 3000 }));
    const rows = store.getUnprocessedMessagesForGroup("123@g.us", 2);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("getUnprocessedMessagesForGroup scopes to the requested group", () => {
    store.upsertMessage(msg({ id: "a", groupJid: "g1@g.us", ts: 1000 }));
    store.upsertMessage(msg({ id: "b", groupJid: "g2@g.us", ts: 2000 }));
    expect(
      store.getUnprocessedMessagesForGroup("g1@g.us", 10).map((r) => r.id),
    ).toEqual(["a"]);
    expect(
      store.getUnprocessedMessagesForGroup("g2@g.us", 10).map((r) => r.id),
    ).toEqual(["b"]);
  });

  test("getGroupsWithUnprocessed lists distinct groups oldest-group first", () => {
    // g2's oldest pending message predates g1's, so g2 sorts first.
    store.upsertMessage(msg({ id: "g1a", groupJid: "g1@g.us", ts: 2000 }));
    store.upsertMessage(msg({ id: "g1b", groupJid: "g1@g.us", ts: 4000 }));
    store.upsertMessage(msg({ id: "g2a", groupJid: "g2@g.us", ts: 1000 }));
    expect(store.getGroupsWithUnprocessed()).toEqual(["g2@g.us", "g1@g.us"]);
  });

  test("getGroupsWithUnprocessed drops a group once all its messages are processed", () => {
    store.upsertMessage(msg({ id: "a", groupJid: "g1@g.us", ts: 1000 }));
    store.upsertMessage(msg({ id: "b", groupJid: "g2@g.us", ts: 2000 }));
    store.markProcessed(["a"]);
    expect(store.getGroupsWithUnprocessed()).toEqual(["g2@g.us"]);
  });

  test("markProcessed removes messages from the unprocessed queue", () => {
    store.upsertMessage(msg({ id: "a", ts: 1000 }));
    store.upsertMessage(msg({ id: "b", ts: 2000 }));
    store.markProcessed(["a"]);
    const rows = store.getUnprocessedMessagesForGroup("123@g.us", 10);
    expect(rows.map((r) => r.id)).toEqual(["b"]);
  });

  test("markProcessed with empty list is a no-op", () => {
    store.upsertMessage(msg());
    store.markProcessed([]);
    expect(store.getUnprocessedMessagesForGroup("123@g.us", 10)).toHaveLength(1);
  });
});

describe("WhatsAppStore tasks", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("createTask fills defaults and generates an id", () => {
    const task = store.createTask({ task: "Ship the QR flow" });
    expect(task.id).toBeTruthy();
    expect(task.status).toBe("open");
    expect(task.priority).toBeNull();
    expect(task.owner).toBeNull();
    expect(task.notionPageId).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({ task: "Ship the QR flow" });
  });

  test("createTask honors provided fields", () => {
    const task = store.createTask({
      id: "t1",
      task: "Fix backfill",
      owner: "Alice",
      priority: "p0",
      status: "in-progress",
      notes: "urgent",
      groupJid: "123@g.us",
      sourceMsgId: "msg-1",
    });
    expect(task).toMatchObject({
      id: "t1",
      owner: "Alice",
      priority: "p0",
      status: "in-progress",
      groupJid: "123@g.us",
      sourceMsgId: "msg-1",
    });
  });

  test("updateTask patches only provided fields and bumps updatedAt", async () => {
    const task = store.createTask({ task: "A", owner: "Alice", priority: "p2" });
    await Bun.sleep(2);
    const updated = store.updateTask(task.id, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(updated?.owner).toBe("Alice");
    expect(updated?.priority).toBe("p2");
    expect(updated!.updatedAt).toBeGreaterThan(task.updatedAt);
  });

  test("updateTask returns undefined for an unknown id", () => {
    expect(store.updateTask("nope", { status: "done" })).toBeUndefined();
  });

  test("getOpenTasks returns all non-done tasks, optionally by group", () => {
    store.createTask({ task: "open-a", groupJid: "g1@g.us" });
    store.createTask({ task: "open-b", groupJid: "g2@g.us" });
    const inProgress = store.createTask({
      task: "in-progress-d",
      groupJid: "g1@g.us",
    });
    store.updateTask(inProgress.id, { status: "in-progress" });
    const blocked = store.createTask({ task: "blocked-e", groupJid: "g2@g.us" });
    store.updateTask(blocked.id, { status: "blocked" });
    const done = store.createTask({ task: "done-c", groupJid: "g1@g.us" });
    store.updateTask(done.id, { status: "done" });

    expect(store.getOpenTasks().map((t) => t.task).sort()).toEqual([
      "blocked-e",
      "in-progress-d",
      "open-a",
      "open-b",
    ]);
    expect(store.getOpenTasks("g1@g.us").map((t) => t.task)).toEqual([
      "open-a",
      "in-progress-d",
    ]);
  });

  test("getTasksByOwner scopes to one owner", () => {
    store.createTask({ task: "a", owner: "Alice" });
    store.createTask({ task: "b", owner: "Bob" });
    store.createTask({ task: "c", owner: "Alice" });
    expect(store.getTasksByOwner("Alice").map((t) => t.task).sort()).toEqual([
      "a",
      "c",
    ]);
  });

  test("setNotionPageId records the page id and clears the dirty flag", () => {
    const task = store.createTask({ task: "sync me" });
    expect(task.notionDirty).toBe(true); // fresh task is unsynced
    store.setNotionPageId(task.id, "notion-page-123");
    const synced = store.getTask(task.id);
    expect(synced?.notionPageId).toBe("notion-page-123");
    expect(synced?.notionDirty).toBe(false);
  });

  test("updateTask re-dirties a previously synced task", () => {
    const task = store.createTask({ task: "sync me" });
    store.setNotionPageId(task.id, "notion-page-123");
    expect(store.getTask(task.id)?.notionDirty).toBe(false);
    store.updateTask(task.id, { status: "in-progress" });
    expect(store.getTask(task.id)?.notionDirty).toBe(true);
  });

  test("markNotionSynced clears dirty for the given ids only", () => {
    const a = store.createTask({ task: "a" });
    const b = store.createTask({ task: "b" });
    store.markNotionSynced([a.id]);
    expect(store.getTask(a.id)?.notionDirty).toBe(false);
    expect(store.getTask(b.id)?.notionDirty).toBe(true);
    store.markNotionSynced([]); // no-op
    expect(store.getTask(b.id)?.notionDirty).toBe(true);
  });

  test("allTasks returns every task oldest-first", () => {
    store.createTask({ id: "1", task: "first" });
    store.createTask({ id: "2", task: "second" });
    expect(store.allTasks().map((t) => t.id)).toEqual(["1", "2"]);
  });
});
