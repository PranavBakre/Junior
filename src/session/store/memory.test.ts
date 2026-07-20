import { describe, it, expect, beforeEach } from "bun:test";
import { InMemorySessionStore } from "./memory.ts";
import { SessionVersionConflictError } from "./interface.ts";
import { createSession, type AgentSession } from "../types.ts";

function makeAgent(
  name: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    agentName: name,
    provider: "claude",
    sessionId: null,
    status: "idle",
    pendingMessages: [],
    lastActivity: Date.now(),
    pid: null,
    stateVersion: 0,
    ...overrides,
  };
}

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

  it("getRecent filters by lastActivity", async () => {
    const now = Date.now();
    const fresh = createSession("fresh", "c1");
    fresh.lastActivity = now - 1000;
    const stale = createSession("stale", "c1");
    stale.lastActivity = now - 10 * 24 * 60 * 60 * 1000;
    await store.set("fresh", fresh);
    await store.set("stale", stale);

    const recent = await store.getRecent(2 * 24 * 60 * 60 * 1000);
    expect(recent.size).toBe(1);
    expect(recent.has("fresh")).toBe(true);
    expect(recent.has("stale")).toBe(false);
  });

  it("increments stateVersion on set and mutateThread", async () => {
    const session = createSession("thread-1", "channel-1");
    await store.set("thread-1", session);
    const v1 = await store.get("thread-1");
    expect(v1!.stateVersion).toBe(1);

    await store.mutateThread("thread-1", (s) => {
      s.status = "busy";
    });
    const v2 = await store.get("thread-1");
    expect(v2!.stateVersion).toBe(2);
    expect(v2!.status).toBe("busy");
  });

  it("concurrent mutateThread on same thread preserves both agents", async () => {
    await store.set("thread-1", createSession("thread-1", "channel-1"));

    await Promise.all([
      store.mutateThread("thread-1", async (s) => {
        // Yield so both mutators are in flight before either commits.
        await Promise.resolve();
        s.agentSessions.review = makeAgent("review", { status: "busy" });
      }),
      store.mutateThread("thread-1", async (s) => {
        await Promise.resolve();
        s.agentSessions.reproducer = makeAgent("reproducer", {
          status: "busy",
        });
      }),
    ]);

    const retrieved = await store.get("thread-1");
    expect(Object.keys(retrieved!.agentSessions).sort()).toEqual([
      "reproducer",
      "review",
    ]);
  });

  it("concurrent session-id persist and pending-message append both survive", async () => {
    const session = createSession("thread-1", "channel-1");
    session.agentSessions.review = makeAgent("review", { status: "busy" });
    await store.set("thread-1", session);

    await Promise.all([
      store.mutateThread("thread-1", (s) => {
        s.agentSessions.review.sessionId = "review-session-42";
      }),
      store.mutateThread("thread-1", (s) => {
        s.agentSessions.review.pendingMessages.push({
          user: "U9",
          text: "follow-up",
          ts: "9.9",
        });
      }),
    ]);

    const retrieved = await store.get("thread-1");
    expect(retrieved!.agentSessions.review.sessionId).toBe("review-session-42");
    expect(retrieved!.agentSessions.review.pendingMessages).toEqual([
      { user: "U9", text: "follow-up", ts: "9.9" },
    ]);
  });

  it("stale CAS throws SessionVersionConflictError; mutateThread retries succeed", async () => {
    await store.set("thread-1", createSession("thread-1", "channel-1"));
    const current = await store.get("thread-1");
    expect(current!.stateVersion).toBe(1);

    expect(() => {
      store.casSet(
        "thread-1",
        createSession("thread-1", "channel-1"),
        /*expectedVersion*/ 0,
      );
    }).toThrow(SessionVersionConflictError);

    const updated = await store.mutateThread("thread-1", (s) => {
      s.status = "busy";
    });
    expect(updated.status).toBe("busy");
    expect(updated.stateVersion).toBe(2);
  });

  it("mutateThread throws when session is missing", async () => {
    await expect(
      store.mutateThread("missing", (s) => {
        s.status = "busy";
      }),
    ).rejects.toThrow("session not found: missing");
  });

  it("mutateAgent updates one agent without dropping siblings", async () => {
    const session = createSession("thread-1", "channel-1");
    session.agentSessions.review = makeAgent("review", { status: "busy" });
    session.agentSessions.reproducer = makeAgent("reproducer", {
      status: "idle",
    });
    await store.set("thread-1", session);

    await store.mutateAgent("thread-1", "review", (agent) => {
      agent.status = "done";
    });

    const retrieved = await store.get("thread-1");
    expect(retrieved!.agentSessions.review.status).toBe("done");
    expect(retrieved!.agentSessions.reproducer.status).toBe("idle");
  });
});
