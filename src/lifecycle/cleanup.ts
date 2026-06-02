import { resolve } from "node:path";
import type { SessionStore } from "../session/store/interface.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { SqliteSessionStore } from "../session/store/sqlite.ts";

export async function cleanupStaleSessions(
  store: SessionStore,
  staleTimeoutMs: number,
): Promise<string[]> {
  const sessions = await store.getAll();
  const cleaned: string[] = [];

  for (const [threadId, session] of sessions) {
    if (Date.now() - session.lastActivity > staleTimeoutMs) {
      if (session.status === "busy" || session.status === "draining") {
        continue;
      }
      // Don't delete the thread if any persistent agent session is still
      // active — the top-level status may be idle while a worker (reproducer,
      // thinker, reviewer, etc.) is mid-run.
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
  try {
    const staleTimeoutMs = parsePositiveIntegerEnv(
      env.SESSION_STALE_TIMEOUT_MS,
      86_400_000,
      "SESSION_STALE_TIMEOUT_MS",
    );
    const cleaned = await cleanupStaleSessions(store, staleTimeoutMs);
    logger.log(`Removed ${cleaned.length} stale session(s).`);
    if (cleaned.length > 0) {
      logger.log(cleaned.join("\n"));
    }
    return cleaned;
  } finally {
    store.close?.();
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
