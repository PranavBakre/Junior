import { describe, it, expect, beforeEach } from "bun:test";
import { InMemorySessionStore } from "./memory.ts";
import { createSession } from "../types.ts";

describe("InMemorySessionStore", () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  it("get returns undefined for unknown threadId", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeUndefined();
  });

  it("set then get returns the session", async () => {
    const session = createSession("thread-1", "channel-1");
    await store.set("thread-1", session);

    const retrieved = await store.get("thread-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.threadId).toBe("thread-1");
    expect(retrieved!.channel).toBe("channel-1");
    expect(retrieved!.status).toBe("idle");
  });

  it("delete removes the session", async () => {
    const session = createSession("thread-1", "channel-1");
    await store.set("thread-1", session);

    await store.delete("thread-1");

    const result = await store.get("thread-1");
    expect(result).toBeUndefined();
  });

  it("delete on nonexistent key does not throw", async () => {
    await expect(store.delete("nonexistent")).resolves.toBeUndefined();
  });

  it("getAll returns all sessions", async () => {
    const s1 = createSession("thread-1", "channel-1");
    const s2 = createSession("thread-2", "channel-2");
    const s3 = createSession("thread-3", "channel-1");

    await store.set("thread-1", s1);
    await store.set("thread-2", s2);
    await store.set("thread-3", s3);

    const all = await store.getAll();
    expect(all.size).toBe(3);
    expect(all.get("thread-1")?.threadId).toBe("thread-1");
    expect(all.get("thread-2")?.threadId).toBe("thread-2");
    expect(all.get("thread-3")?.threadId).toBe("thread-3");
  });

  it("getAll returns a copy (mutations don't affect store)", async () => {
    const s1 = createSession("thread-1", "channel-1");
    await store.set("thread-1", s1);

    const all = await store.getAll();
    all.delete("thread-1");

    const stillThere = await store.get("thread-1");
    expect(stillThere).toBeDefined();
  });

  it("getAll returns empty map when store is empty", async () => {
    const all = await store.getAll();
    expect(all.size).toBe(0);
  });

  it("updateActivity updates lastActivity timestamp", async () => {
    const session = createSession("thread-1", "channel-1");
    const originalActivity = session.lastActivity;
    await store.set("thread-1", session);

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    await store.updateActivity("thread-1");

    const updated = await store.get("thread-1");
    expect(updated).toBeDefined();
    expect(updated!.lastActivity).toBeGreaterThan(originalActivity);
  });

  it("updateActivity on nonexistent key does not throw", async () => {
    await expect(store.updateActivity("nonexistent")).resolves.toBeUndefined();
  });
});
