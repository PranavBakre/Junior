import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteSessionStore } from "./sqlite.ts";
import { createSession } from "../types.ts";

describe("SqliteSessionStore", () => {
  let tmpDir: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-sqlite-"));
    store = new SqliteSessionStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("get returns undefined for unknown threadId", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeUndefined();
  });

  it("set then get round-trips all fields", async () => {
    const session = createSession("thread-1", "channel-1");
    session.sessionId = "sess-abc";
    session.agentType = "build";
    session.worktreePath = "/tmp/wt";
    session.status = "busy";
    session.pendingMessages = [
      { user: "U1", text: "hi", ts: "1.2" },
    ];
    await store.set("thread-1", session);

    const retrieved = await store.get("thread-1");
    expect(retrieved).toEqual(session);
  });

  it("persists agent sessions in the agent_sessions table", async () => {
    const session = createSession("thread-1", "channel-1");
    session.agentSessions.echo = {
      agentName: "echo",
      provider: "opencode",
      sessionId: "echo-session",
      status: "busy",
      pendingMessages: [{ user: "U1", text: "next", ts: "2.3" }],
      lastActivity: 12345,
      pid: 987,
    };

    await store.set("thread-1", session);

    const retrieved = await store.get("thread-1");
    expect(retrieved!.agentSessions.echo).toEqual(
      session.agentSessions.echo,
    );
  });

  it("persists provider beside thread and agent session ids", async () => {
    const session = createSession("thread-1", "channel-1");
    session.provider = "opencode";
    session.sessionId = "thread-session";
    session.agentSessions.worker = {
      agentName: "worker",
      provider: "opencode",
      sessionId: "worker-session",
      status: "idle",
      pendingMessages: [],
      lastActivity: 12345,
      pid: null,
    };

    await store.set("thread-1", session);

    const retrieved = await store.get("thread-1");
    expect(retrieved!.provider).toBe("opencode");
    expect(retrieved!.sessionId).toBe("thread-session");
    expect(retrieved!.agentSessions.worker.provider).toBe("opencode");
    expect(retrieved!.agentSessions.worker.sessionId).toBe("worker-session");
  });

  it("demotes persisted unimplemented providers to claude", async () => {
    const now = Date.now();
    const session = createSession("codex-thread", "channel-1");
    session.provider = "codex";
    session.agentSessions.worker = {
      agentName: "worker",
      provider: "codex",
      sessionId: "worker-session",
      status: "idle",
      pendingMessages: [],
      lastActivity: now,
      pid: null,
    };

    const db = (store as unknown as { db: Database }).db;
    db.query(
      `INSERT INTO sessions (thread_id, json, last_activity, status)
       VALUES (?, ?, ?, ?)`,
    ).run(
      session.threadId,
      JSON.stringify(session),
      session.lastActivity,
      session.status,
    );
    db.query(
      `INSERT INTO agent_sessions
       (thread_id, agent_name, provider, session_id, status, last_activity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("codex-thread", "worker", "codex", "worker-session", "idle", now);

    const retrieved = await store.get("codex-thread");
    expect(retrieved!.provider).toBe("claude");
    expect(retrieved!.agentSessions.worker.provider).toBe("claude");
  });

  it("normalizes legacy sessions without provider fields to claude", async () => {
    const now = Date.now();
    const legacy = createSession("legacy-thread", "channel-1");
    legacy.sessionId = "legacy-session";
    legacy.agentSessions.worker = {
      agentName: "worker",
      sessionId: "worker-session",
      status: "idle",
      pendingMessages: [],
      lastActivity: now,
      pid: null,
    };
    delete legacy.provider;
    delete legacy.agentSessions.worker.provider;

    const db = (store as unknown as { db: Database }).db;
    db.query(
      `INSERT INTO sessions (thread_id, json, last_activity, status)
       VALUES (?, ?, ?, ?)`,
    ).run(
      legacy.threadId,
      JSON.stringify(legacy),
      legacy.lastActivity,
      legacy.status,
    );
    db.query(
      `INSERT INTO agent_sessions
       (thread_id, agent_name, session_id, status, last_activity)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("legacy-thread", "worker", "worker-session", "idle", now);

    const retrieved = await store.get("legacy-thread");
    expect(retrieved!.provider).toBe("claude");
    expect(retrieved!.agentSessions.worker.provider).toBe("claude");
  });

  it("set on existing threadId upserts", async () => {
    const s1 = createSession("thread-1", "channel-1");
    await store.set("thread-1", s1);

    const s2 = createSession("thread-1", "channel-2");
    s2.status = "busy";
    await store.set("thread-1", s2);

    const retrieved = await store.get("thread-1");
    expect(retrieved!.channel).toBe("channel-2");
    expect(retrieved!.status).toBe("busy");
  });

  it("delete removes the session", async () => {
    const session = createSession("thread-1", "channel-1");
    await store.set("thread-1", session);
    await store.delete("thread-1");

    const result = await store.get("thread-1");
    expect(result).toBeUndefined();
  });

  it("delete on nonexistent key does not throw", async () => {
    expect(store.delete("nonexistent")).resolves.toBeUndefined();
  });

  it("getAll returns all sessions", async () => {
    await store.set("t1", createSession("t1", "c1"));
    await store.set("t2", createSession("t2", "c2"));
    await store.set("t3", createSession("t3", "c1"));

    const all = await store.getAll();
    expect(all.size).toBe(3);
    expect(all.get("t1")?.threadId).toBe("t1");
    expect(all.get("t2")?.threadId).toBe("t2");
    expect(all.get("t3")?.threadId).toBe("t3");
  });

  it("getAll returns empty map when store is empty", async () => {
    const all = await store.getAll();
    expect(all.size).toBe(0);
  });

  it("getRecent filters by lastActivity", async () => {
    const now = Date.now();

    const fresh = createSession("fresh", "c1");
    fresh.lastActivity = now - 1000;
    await store.set("fresh", fresh);

    const stale = createSession("stale", "c1");
    stale.lastActivity = now - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    await store.set("stale", stale);

    const recent = await store.getRecent(2 * 24 * 60 * 60 * 1000); // 2 days
    expect(recent.size).toBe(1);
    expect(recent.has("fresh")).toBe(true);
    expect(recent.has("stale")).toBe(false);
  });

  it("getRecent includes rows at the exact cutoff", async () => {
    const session = createSession("edge", "c1");
    session.lastActivity = Date.now() - 1000;
    await store.set("edge", session);

    const recent = await store.getRecent(60_000);
    expect(recent.has("edge")).toBe(true);
  });

  it("updateActivity updates lastActivity timestamp", async () => {
    const session = createSession("thread-1", "channel-1");
    const originalActivity = session.lastActivity;
    await store.set("thread-1", session);

    await new Promise((r) => setTimeout(r, 10));
    await store.updateActivity("thread-1");

    const updated = await store.get("thread-1");
    expect(updated!.lastActivity).toBeGreaterThan(originalActivity);
  });

  it("updateActivity on nonexistent key does not throw", async () => {
    expect(store.updateActivity("nonexistent")).resolves.toBeUndefined();
  });

  it("sessions persist across store instances (same db file)", async () => {
    const dbPath = join(tmpDir, "persist.db");
    const s1 = new SqliteSessionStore(dbPath);
    const session = createSession("thread-1", "channel-1");
    session.sessionId = "sess-xyz";
    await s1.set("thread-1", session);
    s1.close();

    const s2 = new SqliteSessionStore(dbPath);
    const retrieved = await s2.get("thread-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.sessionId).toBe("sess-xyz");
    s2.close();
  });
});
