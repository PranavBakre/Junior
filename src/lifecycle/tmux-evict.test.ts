import { describe, it, expect } from "bun:test";
import { evictIdleTmuxSessions } from "./tmux-evict.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { createSession } from "../session/types.ts";
import type { TmuxDriver } from "../claude/tmux-driver.ts";

interface CloseCall {
  threadId: string;
  agentName: string;
}

function fakeDriver(): {
  driver: TmuxDriver;
  closeCalls: CloseCall[];
  /** Setter used by the racy-eviction test to flip status mid-close. */
  onClose?: (call: CloseCall) => Promise<void>;
} {
  const closeCalls: CloseCall[] = [];
  const harness: { onClose?: (call: CloseCall) => Promise<void> } = {};
  const driver = {
    close: async (threadId: string, agentName: string) => {
      const call = { threadId, agentName };
      closeCalls.push(call);
      if (harness.onClose) await harness.onClose(call);
    },
  } as unknown as TmuxDriver;
  return { driver, closeCalls, get onClose() { return harness.onClose; }, set onClose(v) { harness.onClose = v; } };
}

describe("evictIdleTmuxSessions", () => {
  it("evicts top-level tmux session when idle past TTL — uses topLevelTmuxAgent, not literal 'lead'", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    session.tmuxSessionName = "junior-T1-default";
    session.topLevelTmuxAgent = "default";
    session.lastActivity = Date.now() - 1_000_000;
    await store.set("T1", session);

    const { driver, closeCalls } = fakeDriver();
    const result = await evictIdleTmuxSessions(store, driver, { ttlMs: 60_000 });

    expect(result.evicted).toEqual(["T1:default"]);
    expect(closeCalls).toEqual([{ threadId: "T1", agentName: "default" }]);
    const after = (await store.get("T1"))!;
    expect(after.tmuxSessionName).toBeNull();
    expect(after.topLevelTmuxAgent).toBeNull();
  });

  it("leaves a fresh tmux session alone", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    session.tmuxSessionName = "junior-T1-default";
    session.topLevelTmuxAgent = "default";
    session.lastActivity = Date.now() - 5_000;
    await store.set("T1", session);

    const { driver, closeCalls } = fakeDriver();
    const result = await evictIdleTmuxSessions(store, driver, { ttlMs: 60_000 });

    expect(result.evicted).toEqual([]);
    expect(closeCalls).toEqual([]);
    const after = (await store.get("T1"))!;
    expect(after.tmuxSessionName).toBe("junior-T1-default");
  });

  it("skipBusy = true exempts busy rows from eviction", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    session.tmuxSessionName = "junior-T1-default";
    session.topLevelTmuxAgent = "default";
    session.lastActivity = Date.now() - 1_000_000;
    session.status = "busy";
    await store.set("T1", session);

    const { driver, closeCalls } = fakeDriver();
    const result = await evictIdleTmuxSessions(store, driver, {
      ttlMs: 60_000,
      skipBusy: true,
    });

    expect(result.evicted).toEqual([]);
    expect(closeCalls).toEqual([]);
  });

  it("re-reads the row inside the critical section — a turn that started after snapshot is spared", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    session.tmuxSessionName = "junior-T1-default";
    session.topLevelTmuxAgent = "default";
    session.lastActivity = Date.now() - 1_000_000;
    session.status = "idle"; // snapshot sees idle
    await store.set("T1", session);

    const { driver, closeCalls } = fakeDriver();

    // Race simulation: between snapshot read and close(), a new turn flips
    // status to "busy" and bumps lastActivity. The re-read inside the loop
    // must see this and bail out — otherwise we'd kill an in-flight turn.
    const fresh = (await store.get("T1"))!;
    fresh.status = "busy";
    fresh.lastActivity = Date.now();
    await store.set("T1", fresh);

    const result = await evictIdleTmuxSessions(store, driver, {
      ttlMs: 60_000,
      skipBusy: true,
    });

    expect(result.evicted).toEqual([]);
    expect(closeCalls).toEqual([]);
    // Row should be untouched
    const after = (await store.get("T1"))!;
    expect(after.tmuxSessionName).toBe("junior-T1-default");
    expect(after.status).toBe("busy");
  });

  it("evicts per-agent tmux sessions independently of the top-level", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    // Top-level is fresh; per-agent is stale.
    session.tmuxSessionName = "junior-T1-default";
    session.topLevelTmuxAgent = "default";
    session.lastActivity = Date.now() - 5_000;
    session.agentSessions = {
      reviewer: {
        agentName: "reviewer",
        sessionId: "rev-1",
        status: "idle",
        pendingMessages: [],
        lastActivity: Date.now() - 1_000_000,
        pid: null,
        tmuxSessionName: "junior-T1-reviewer",
      },
    };
    await store.set("T1", session);

    const { driver, closeCalls } = fakeDriver();
    const result = await evictIdleTmuxSessions(store, driver, { ttlMs: 60_000 });

    expect(closeCalls).toEqual([{ threadId: "T1", agentName: "reviewer" }]);
    expect(result.evicted).toEqual(["T1:reviewer"]);
    const after = (await store.get("T1"))!;
    expect(after.tmuxSessionName).toBe("junior-T1-default"); // untouched
    expect(after.agentSessions.reviewer.tmuxSessionName).toBeNull();
  });

  it("ignores headless-mode sessions", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "headless");
    session.lastActivity = Date.now() - 1_000_000;
    await store.set("T1", session);

    const { driver, closeCalls } = fakeDriver();
    const result = await evictIdleTmuxSessions(store, driver, { ttlMs: 60_000 });

    expect(result.evicted).toEqual([]);
    expect(closeCalls).toEqual([]);
  });
});
