import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupStaleSessions, runCleanupFromEnv } from "./cleanup.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { SqliteSessionStore } from "../session/store/sqlite.ts";
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

  it("keeps stale draining sessions", async () => {
    const store = makeStore();
    const session = createSession("thread-1", "channel-1");
    session.lastActivity = Date.now() - 100_000;
    session.status = "draining";
    await store.set("thread-1", session);

    // draining sessions are about to spawn — don't delete them
    const cleaned = await cleanupStaleSessions(store, 50_000);
    expect(cleaned).toEqual([]);
    expect(await store.get("thread-1")).toBeDefined();
  });

  it("CLI entrypoint cleans persisted sqlite sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-cleanup-test-"));
    const dbPath = join(dir, "sessions.db");
    const store = new SqliteSessionStore(dbPath);

    try {
      const staleIdle = createSession("stale-idle", "channel-1");
      staleIdle.lastActivity = Date.now() - 100_000;
      staleIdle.status = "idle";
      await store.set("stale-idle", staleIdle);
      store.close();

      const logs: unknown[] = [];
      const cleaned = await runCleanupFromEnv(
        {
          SESSION_STORE: "sqlite",
          SESSION_DB_PATH: dbPath,
          SESSION_STALE_TIMEOUT_MS: "50000",
        },
        { log: (message?: unknown) => logs.push(message) },
      );

      const verificationStore = new SqliteSessionStore(dbPath);
      try {
        expect(cleaned).toEqual(["stale-idle"]);
        expect(await verificationStore.get("stale-idle")).toBeUndefined();
        expect(logs).toContain("Removed 1 stale session(s).");
      } finally {
        verificationStore.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
