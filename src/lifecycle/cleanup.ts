import { resolve } from "node:path";
import type { SessionStore } from "../session/store/interface.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { SqliteSessionStore } from "../session/store/sqlite.ts";
import type { UsageStore } from "../usage/store/interface.ts";
import { createUsageStore } from "../usage/store/factory.ts";
import type { DashboardAuditStore } from "../http/audit/interface.ts";
import { createDashboardAuditStore } from "../http/audit/factory.ts";

export const USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export async function cleanupStaleSessions(
  store: SessionStore,
  staleTimeoutMs: number,
  shouldPreservePipelineRun?: (
    runId: string,
    staleBefore: number,
  ) => Promise<boolean>,
): Promise<string[]> {
  const sessions = await store.getAll();
  const cleaned: string[] = [];
  const now = Date.now();
  const staleBefore = now - staleTimeoutMs;

  for (const [threadId, session] of sessions) {
    if (session.lastActivity < staleBefore) {
      // A pipeline run owns durable work beyond any individual model turn.
      // Preserve its session row so startup reconciliation can resume it.
      const activeRunId = session.activeRunId ?? session.activePipelineRunId;
      if (
        activeRunId &&
        (!shouldPreservePipelineRun ||
          await shouldPreservePipelineRun(
            activeRunId,
            staleBefore,
          ))
      ) continue;
      if (session.status === "busy" || session.status === "draining") {
        continue;
      }
      // Don't delete the thread if any persistent agent session is still
      // active — the top-level status may be idle while a worker (reproducer,
      // reviewer, etc.) is mid-run.
      const hasBusyAgent = Object.values(session.agentSessions ?? {}).some(
        (a) => a.status === "busy",
      );
      if (hasBusyAgent) {
        continue;
      }
      await store.delete(threadId);
      cleaned.push(threadId);
    }
  }

  return cleaned;
}

export async function cleanupOperationalTables(options: {
  usageStore?: Pick<UsageStore, "deleteOlderThan">;
  auditStore?: Pick<DashboardAuditStore, "deleteOlderThan">;
  now?: number;
}): Promise<{ usageDeleted: number; auditDeleted: number }> {
  const now = options.now ?? Date.now();
  const usageDeleted = options.usageStore
    ? await options.usageStore.deleteOlderThan(now - USAGE_RETENTION_MS)
    : 0;
  const auditDeleted = options.auditStore
    ? await options.auditStore.deleteOlderThan(now - AUDIT_RETENTION_MS)
    : 0;
  return { usageDeleted, auditDeleted };
}

interface CleanupEnv extends Record<string, string | undefined> {
  SESSION_STORE?: string;
  SESSION_DB_PATH?: string;
  SESSION_STALE_TIMEOUT_MS?: string;
}

interface CleanupLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
}

type ClosableSessionStore = SessionStore & { close?: () => void };

export async function runCleanupFromEnv(
  env: CleanupEnv = process.env,
  logger: CleanupLogger = console,
): Promise<string[]> {
  const store = createCleanupStore(env);
  const storeKind = env.SESSION_STORE ?? "sqlite";
  const sqlitePath = resolve(env.SESSION_DB_PATH ?? "data/sessions.db");
  const usageStore = createUsageStore({
    kind: storeKind === "memory" ? "memory" : "sqlite",
    sqlitePath,
  });
  const auditStore = createDashboardAuditStore({
    kind: storeKind === "memory" ? "memory" : "sqlite",
    sqlitePath,
  });
  try {
    const staleTimeoutMs = parsePositiveIntegerEnv(
      env.SESSION_STALE_TIMEOUT_MS,
      86_400_000,
      "SESSION_STALE_TIMEOUT_MS",
    );
    const cleaned = await cleanupStaleSessions(store, staleTimeoutMs);
    const operational = await cleanupOperationalTables({
      usageStore,
      auditStore,
    });
    logger.log(`Removed ${cleaned.length} stale session(s).`);
    if (cleaned.length > 0) {
      logger.log(cleaned.join("\n"));
    }
    if (operational.usageDeleted > 0 || operational.auditDeleted > 0) {
      logger.log(
        `Removed ${operational.usageDeleted} usage event(s) and ${operational.auditDeleted} audit row(s).`,
      );
    }
    return cleaned;
  } finally {
    store.close?.();
    usageStore.close?.();
    auditStore.close?.();
  }
}

function createCleanupStore(env: CleanupEnv): ClosableSessionStore {
  const storeKind = env.SESSION_STORE ?? "sqlite";
  if (storeKind === "memory") return new InMemorySessionStore();
  if (storeKind === "sqlite") {
    return new SqliteSessionStore(resolve(env.SESSION_DB_PATH ?? "data/sessions.db"));
  }
  throw new Error(`Invalid SESSION_STORE: ${storeKind} (expected memory|sqlite)`);
}

function parsePositiveIntegerEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} (expected positive integer)`);
  }
  return value;
}

if (import.meta.main) {
  runCleanupFromEnv().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
