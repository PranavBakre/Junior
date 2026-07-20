import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteSessionStore } from "./sqlite.ts";
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

  it("round-trips active pipeline invocations through parent JSON and agent rows", async () => {
    const session = createSession("pipeline-thread", "channel-1");
    session.activePipelineInvocation = {
      runId: "run-top",
      assignmentId: "asg-top",
      dispatchKey: "dispatch-top",
      outcomeCountAtDispatch: 2,
      retryCount: 1,
    };
    session.agentSessions.build = makeAgent("build", {
      activePipelineInvocation: {
        runId: "run-agent",
        assignmentId: "asg-agent",
        dispatchKey: "dispatch-agent",
        outcomeCountAtDispatch: 4,
        retryCount: 2,
      },
    });

    await store.set(session.threadId, session);

    const retrieved = await store.get(session.threadId);
    expect(retrieved?.activePipelineInvocation).toEqual(
      session.activePipelineInvocation,
    );
    expect(retrieved?.agentSessions.build?.activePipelineInvocation).toEqual(
      session.agentSessions.build.activePipelineInvocation,
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

  it("normalizes missing stateVersion to 0 on load", async () => {
    const session = createSession("thread-1", "channel-1");
    delete session.stateVersion;
    const db = (store as unknown as { db: Database }).db;
    db.query(
      `INSERT INTO sessions (thread_id, json, last_activity, status, state_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      session.threadId,
      JSON.stringify(session),
      session.lastActivity,
      session.status,
      0,
    );

    const retrieved = await store.get("thread-1");
    expect(retrieved!.stateVersion).toBe(0);
  });

  it("increments stateVersion on set", async () => {
    const session = createSession("thread-1", "channel-1");
    expect(session.stateVersion).toBe(0);
    await store.set("thread-1", session);
    const v1 = await store.get("thread-1");
    expect(v1!.stateVersion).toBe(1);

    v1!.status = "busy";
    await store.set("thread-1", v1!);
    const v2 = await store.get("thread-1");
    expect(v2!.stateVersion).toBe(2);
  });

  it("dual-writes agent pending, pid, and tmux fields to agent_sessions rows", async () => {
    const session = createSession("thread-1", "channel-1");
    session.agentSessions.review = makeAgent("review", {
      status: "busy",
      sessionId: "rev-1",
      pendingMessages: [{ user: "U1", text: "next", ts: "1.2" }],
      pid: 4242,
      tmuxSessionName: "junior-t1-review",
    });
    await store.set("thread-1", session);

    const db = (store as unknown as { db: Database }).db;
    const row = db
      .query<
        {
          pending_json: string | null;
          pid: number | null;
          tmux_session_name: string | null;
          state_version: number;
        },
        [string, string]
      >(
        `SELECT pending_json, pid, tmux_session_name, state_version
         FROM agent_sessions WHERE thread_id = ? AND agent_name = ?`,
      )
      .get("thread-1", "review");

    expect(row).toBeDefined();
    expect(row!.pid).toBe(4242);
    expect(row!.tmux_session_name).toBe("junior-t1-review");
    expect(row!.state_version).toBeGreaterThan(0);
    expect(JSON.parse(row!.pending_json!)).toEqual([
      { user: "U1", text: "next", ts: "1.2" },
    ]);

    // Prefer agent-row pending even if parent JSON is stale.
    const stale = createSession("thread-1", "channel-1");
    stale.stateVersion = (await store.get("thread-1"))!.stateVersion;
    stale.agentSessions.review = makeAgent("review", {
      sessionId: "rev-1",
      status: "busy",
      pendingMessages: [], // empty in JSON
      pid: null,
    });
    // Direct JSON overwrite without touching agent row to simulate legacy skew.
    db.query(
      `UPDATE sessions SET json = ? WHERE thread_id = ?`,
    ).run(JSON.stringify(stale), "thread-1");

    const retrieved = await store.get("thread-1");
    expect(retrieved!.agentSessions.review.pendingMessages).toEqual([
      { user: "U1", text: "next", ts: "1.2" },
    ]);
    expect(retrieved!.agentSessions.review.pid).toBe(4242);
  });

  it("concurrent mutateThread on same thread preserves both agents", async () => {
    const session = createSession("thread-1", "channel-1");
    await store.set("thread-1", session);

    await Promise.all([
      store.mutateThread("thread-1", (s) => {
        s.agentSessions.review = makeAgent("review", {
          status: "busy",
          sessionId: "rev-sess",
        });
      }),
      store.mutateThread("thread-1", (s) => {
        s.agentSessions.reproducer = makeAgent("reproducer", {
          status: "busy",
          sessionId: "rep-sess",
        });
      }),
    ]);

    const retrieved = await store.get("thread-1");
    expect(Object.keys(retrieved!.agentSessions).sort()).toEqual([
      "reproducer",
      "review",
    ]);
    expect(retrieved!.agentSessions.review.status).toBe("busy");
    expect(retrieved!.agentSessions.reproducer.status).toBe("busy");
    expect(retrieved!.agentSessions.review.sessionId).toBe("rev-sess");
    expect(retrieved!.agentSessions.reproducer.sessionId).toBe("rep-sess");
  });

  it("concurrent session-id persist and pending-message append both survive", async () => {
    const session = createSession("thread-1", "channel-1");
    session.agentSessions.review = makeAgent("review", { status: "busy" });
    await store.set("thread-1", session);

    await Promise.all([
      store.mutateThread("thread-1", (s) => {
        const agent = s.agentSessions.review;
        agent.sessionId = "review-session-42";
        agent.provider = "opencode";
      }),
      store.mutateThread("thread-1", (s) => {
        const agent = s.agentSessions.review;
        agent.pendingMessages.push({
          user: "U9",
          text: "follow-up",
          ts: "9.9",
        });
      }),
    ]);

    const retrieved = await store.get("thread-1");
    expect(retrieved!.agentSessions.review.sessionId).toBe("review-session-42");
    expect(retrieved!.agentSessions.review.provider).toBe("opencode");
    expect(retrieved!.agentSessions.review.pendingMessages).toEqual([
      { user: "U9", text: "follow-up", ts: "9.9" },
    ]);
  });

  it("stale CAS throws SessionVersionConflictError; mutateThread retries succeed", async () => {
    const session = createSession("thread-1", "channel-1");
    await store.set("thread-1", session);
    const current = await store.get("thread-1");
    expect(current!.stateVersion).toBe(1);

    // Force-write with wrong expected version.
    expect(() => {
      const stale = createSession("thread-1", "channel-1");
      stale.status = "busy";
      store.casSet("thread-1", stale, /*expectedVersion*/ 0);
    }).toThrow(SessionVersionConflictError);

    // mutateThread still succeeds by re-reading and retrying.
    const updated = await store.mutateThread("thread-1", (s) => {
      s.status = "busy";
      s.agentSessions.echo = makeAgent("echo", { status: "busy" });
    });
    expect(updated.status).toBe("busy");
    expect(updated.agentSessions.echo.status).toBe("busy");
    expect(updated.stateVersion).toBeGreaterThan(1);
  });

  it("two SqliteSessionStore instances against same db pass concurrency tests", async () => {
    const dbPath = join(tmpDir, "concurrent.db");
    const a = new SqliteSessionStore(dbPath);
    const b = new SqliteSessionStore(dbPath);

    await a.set("thread-1", createSession("thread-1", "channel-1"));

    await Promise.all([
      a.mutateThread("thread-1", (s) => {
        s.agentSessions.review = makeAgent("review", {
          status: "busy",
          sessionId: "from-a",
        });
      }),
      b.mutateThread("thread-1", (s) => {
        s.agentSessions.reproducer = makeAgent("reproducer", {
          status: "busy",
          sessionId: "from-b",
        });
      }),
      a.mutateThread("thread-1", (s) => {
        s.pendingMessages.push({ user: "U1", text: "ping", ts: "1" });
      }),
      b.mutateThread("thread-1", (s) => {
        if (s.agentSessions.review) {
          s.agentSessions.review.sessionId =
            s.agentSessions.review.sessionId ?? "from-a";
          s.agentSessions.review.pendingMessages.push({
            user: "U2",
            text: "queued",
            ts: "2",
          });
        } else {
          s.agentSessions.review = makeAgent("review", {
            status: "busy",
            pendingMessages: [{ user: "U2", text: "queued", ts: "2" }],
          });
        }
      }),
    ]);

    const fromA = await a.get("thread-1");
    const fromB = await b.get("thread-1");
    expect(Object.keys(fromA!.agentSessions).sort()).toEqual([
      "reproducer",
      "review",
    ]);
    expect(Object.keys(fromB!.agentSessions).sort()).toEqual([
      "reproducer",
      "review",
    ]);
    expect(fromA!.pendingMessages.some((m) => m.text === "ping")).toBe(true);
    expect(
      fromA!.agentSessions.review.pendingMessages.some((m) => m.text === "queued"),
    ).toBe(true);
    expect(fromA!.stateVersion).toBe(fromB!.stateVersion);

    a.close();
    b.close();
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
      agent.sessionId = "done-sess";
    });

    const retrieved = await store.get("thread-1");
    expect(retrieved!.agentSessions.review.status).toBe("done");
    expect(retrieved!.agentSessions.review.sessionId).toBe("done-sess");
    expect(retrieved!.agentSessions.reproducer.status).toBe("idle");
  });
});
