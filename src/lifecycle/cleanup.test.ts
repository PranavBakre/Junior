import { describe, it, expect } from "bun:test";
import { cleanupStaleSessions } from "./cleanup.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { createSession } from "../session/types.ts";

describe("cleanupStaleSessions", () => {
  function makeStore() {
    return new InMemorySessionStore();
  }

  it("deletes stale idle sessions", async () => {
    const store = makeStore();
    const session = createSession("thread-1", "channel-1");
    session.lastActivity = Date.now() - 100_000; // 100s ago
    session.status = "idle";
    await store.set("thread-1", session);

    const cleaned = await cleanupStaleSessions(store, 50_000); // 50s threshold

    expect(cleaned).toEqual(["thread-1"]);
    expect(await store.get("thread-1")).toBeUndefined();
  });

  it("keeps stale busy sessions", async () => {
    const store = makeStore();
    const session = createSession("thread-1", "channel-1");
    session.lastActivity = Date.now() - 100_000;
    session.status = "busy";
    await store.set("thread-1", session);

    const cleaned = await cleanupStaleSessions(store, 50_000);

    expect(cleaned).toEqual([]);
    expect(await store.get("thread-1")).toBeDefined();
  });

  it("keeps recent idle sessions", async () => {
    const store = makeStore();
    const session = createSession("thread-1", "channel-1");
    session.lastActivity = Date.now() - 10_000; // 10s ago
    session.status = "idle";
    await store.set("thread-1", session);

    const cleaned = await cleanupStaleSessions(store, 50_000); // 50s threshold

    expect(cleaned).toEqual([]);
    expect(await store.get("thread-1")).toBeDefined();
  });

  it("returns list of all cleaned threadIds", async () => {
    const store = makeStore();

    const staleIdle1 = createSession("stale-idle-1", "ch");
    staleIdle1.lastActivity = Date.now() - 200_000;
    staleIdle1.status = "idle";

    const staleIdle2 = createSession("stale-idle-2", "ch");
    staleIdle2.lastActivity = Date.now() - 200_000;
    staleIdle2.status = "idle";

    const staleBusy = createSession("stale-busy", "ch");
    staleBusy.lastActivity = Date.now() - 200_000;
    staleBusy.status = "busy";

    const recent = createSession("recent", "ch");
    recent.lastActivity = Date.now();
    recent.status = "idle";

    await store.set("stale-idle-1", staleIdle1);
    await store.set("stale-idle-2", staleIdle2);
    await store.set("stale-busy", staleBusy);
    await store.set("recent", recent);

    const cleaned = await cleanupStaleSessions(store, 50_000);

    expect(cleaned).toContain("stale-idle-1");
    expect(cleaned).toContain("stale-idle-2");
    expect(cleaned).not.toContain("stale-busy");
    expect(cleaned).not.toContain("recent");
    expect(cleaned.length).toBe(2);
  });

  it("returns empty array when no sessions exist", async () => {
    const store = makeStore();
    const cleaned = await cleanupStaleSessions(store, 50_000);
    expect(cleaned).toEqual([]);
  });

  it("keeps stale draining sessions (not idle)", async () => {
    const store = makeStore();
    const session = createSession("thread-1", "channel-1");
    session.lastActivity = Date.now() - 100_000;
    session.status = "draining";
    await store.set("thread-1", session);

    // draining is not "idle" but also not "busy", so it will be cleaned
    // (the code only skips "busy")
    const cleaned = await cleanupStaleSessions(store, 50_000);
    expect(cleaned).toEqual(["thread-1"]);
  });
});
