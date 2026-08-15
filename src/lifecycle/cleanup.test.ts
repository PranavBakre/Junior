import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AUDIT_RETENTION_MS,
  USAGE_RETENTION_MS,
  cleanupOperationalTables,
  cleanupStaleSessions,
  runCleanupFromEnv,
} from "./cleanup.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { SqliteSessionStore } from "../session/store/sqlite.ts";
import { createSession } from "../session/types.ts";
import { InMemoryUsageStore } from "../usage/store/memory.ts";
import { InMemoryDashboardAuditStore } from "../http/audit/memory.ts";
import { SqliteUsageStore } from "../usage/store/sqlite.ts";
import { SqliteDashboardAuditStore } from "../http/audit/sqlite.ts";
import type { NormalizedUsage } from "../usage/normalize.ts";

describe("cleanupStaleSessions", () => {
  it("keeps stale idle sessions that still own a pipeline run", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("pipeline-thread", "C1");
    session.lastActivity = Date.now() - 100_000;
    session.activePipelineRunId = "run-active";
    await store.set(session.threadId, session);

    expect(await cleanupStaleSessions(store, 50_000)).toEqual([]);
    expect(await store.get(session.threadId)).toBeDefined();
  });

  it("keeps stale idle sessions that own a default durable run", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("default-run-thread", "C1");
    session.lastActivity = Date.now() - 100_000;
    session.activeRunId = "run-default";
    await store.set(session.threadId, session);

    expect(await cleanupStaleSessions(store, 50_000)).toEqual([]);
    expect(await store.get(session.threadId)).toBeDefined();
  });

  it("deletes a stale idle session whose pipeline run is also stale", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("wedged-pipeline-thread", "C1");
    session.lastActivity = Date.now() - 100_000;
    session.activePipelineRunId = "run-wedged";
    await store.set(session.threadId, session);

    const cleaned = await cleanupStaleSessions(
      store,
      50_000,
      async (_runId, staleBefore) => {
        const runUpdatedAt = Date.now() - 100_000;
        return runUpdatedAt >= staleBefore;
      },
    );

    expect(cleaned).toEqual([session.threadId]);
    expect(await store.get(session.threadId)).toBeUndefined();
  });

  it("keeps a stale idle session when its pipeline run was updated recently", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("live-pipeline-thread", "C1");
    session.lastActivity = Date.now() - 100_000;
    session.activePipelineRunId = "run-live";
    await store.set(session.threadId, session);

    const cleaned = await cleanupStaleSessions(
      store,
      50_000,
      async (_runId, staleBefore) => Date.now() >= staleBefore,
    );

    expect(cleaned).toEqual([]);
    expect(await store.get(session.threadId)).toBeDefined();
  });

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

  it("keeps stale idle sessions when an agent session is busy", async () => {
    const store = makeStore();
    const session = createSession("thread-1", "channel-1");
    session.lastActivity = Date.now() - 100_000;
    session.status = "idle";
    session.agentSessions.reproducer = {
      agentName: "reproducer",
      sessionId: "rep-sess-1",
      status: "busy",
      pendingMessages: [],
      lastActivity: Date.now() - 1_000,
      pid: 12345,
    };
    await store.set("thread-1", session);

    const cleaned = await cleanupStaleSessions(store, 50_000);

    expect(cleaned).toEqual([]);
    expect(await store.get("thread-1")).toBeDefined();
  });

  it("deletes stale idle sessions when all agent sessions are done or failed", async () => {
    const store = makeStore();
    const session = createSession("thread-1", "channel-1");
    session.lastActivity = Date.now() - 100_000;
    session.status = "idle";
    session.agentSessions.reproducer = {
      agentName: "reproducer",
      sessionId: "rep-sess-1",
      status: "done",
      pendingMessages: [],
      lastActivity: Date.now() - 100_000,
      pid: null,
    };
    session.agentSessions.thinker = {
      agentName: "thinker",
      sessionId: "think-sess-1",
      status: "failed",
      pendingMessages: [],
      lastActivity: Date.now() - 100_000,
      pid: null,
    };
    await store.set("thread-1", session);

    const cleaned = await cleanupStaleSessions(store, 50_000);

    expect(cleaned).toEqual(["thread-1"]);
    expect(await store.get("thread-1")).toBeUndefined();
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

describe("cleanupOperationalTables", () => {
  it("deletes usage older than 90 days and audit older than 180 days", async () => {
    const now = 2_000_000_000_000;
    const usageStore = new InMemoryUsageStore();
    const auditStore = new InMemoryDashboardAuditStore();
    await usageStore.add(usageEvent({
      sourceId: "old",
      occurredAt: now - USAGE_RETENTION_MS - 1,
    }));
    await usageStore.add(usageEvent({
      sourceId: "fresh",
      occurredAt: now - 1_000,
    }));
    await auditStore.record({
      at: now - AUDIT_RETENTION_MS - 1,
      actor: "dashboard-operator",
      action: "workflow.run",
      targetType: "workflow",
      targetId: "old",
      result: "ok",
    });
    await auditStore.record({
      at: now - 1_000,
      actor: "dashboard-operator",
      action: "session.stop",
      targetType: "session",
      targetId: "fresh",
      result: "ok",
    });

    const report = await cleanupOperationalTables({
      usageStore,
      auditStore,
      now,
    });

    expect(report).toEqual({ usageDeleted: 1, auditDeleted: 1 });
    expect(await usageStore.get("session-turn", "old")).toBeUndefined();
    expect(await usageStore.get("session-turn", "fresh")).toBeDefined();
    expect(await auditStore.list()).toHaveLength(1);
    expect((await auditStore.list())[0]?.targetId).toBe("fresh");
  });

  it("CLI cleanup deletes stale usage and audit rows from sqlite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-cleanup-ops-"));
    const dbPath = join(dir, "sessions.db");
    const now = Date.now();
    const usageStore = new SqliteUsageStore(dbPath);
    const auditStore = new SqliteDashboardAuditStore(dbPath);
    try {
      await usageStore.add(usageEvent({
        sourceId: "old-cli",
        occurredAt: now - USAGE_RETENTION_MS - 5_000,
      }));
      await auditStore.record({
        at: now - AUDIT_RETENTION_MS - 5_000,
        actor: "dashboard-operator",
        action: "workflow.run",
        targetType: "workflow",
        targetId: "old-cli",
        result: "ok",
      });
    } finally {
      usageStore.close();
      auditStore.close();
    }

    const logs: unknown[] = [];
    await runCleanupFromEnv(
      {
        SESSION_STORE: "sqlite",
        SESSION_DB_PATH: dbPath,
        SESSION_STALE_TIMEOUT_MS: "50000",
      },
      { log: (message?: unknown) => logs.push(message) },
    );

    const verifyUsage = new SqliteUsageStore(dbPath);
    const verifyAudit = new SqliteDashboardAuditStore(dbPath);
    try {
      expect(await verifyUsage.get("session-turn", "old-cli")).toBeUndefined();
      expect(await verifyAudit.list()).toEqual([]);
      expect(logs.some((line) =>
        typeof line === "string" && line.includes("usage event")
      )).toBe(true);
    } finally {
      verifyUsage.close();
      verifyAudit.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function usageEvent(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    sourceKind: "session-turn",
    sourceId: "thread-1:default:1",
    threadId: "thread-1",
    channelId: "C1",
    agentName: "default",
    provider: "opencode",
    providerSessionId: null,
    pipelineRunId: null,
    assignmentId: null,
    workflowName: null,
    workflowRunId: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 2,
    costUsd: null,
    costEstimatedUsd: null,
    numTurns: null,
    raw: {},
    occurredAt: Date.now(),
    ...overrides,
  };
}
