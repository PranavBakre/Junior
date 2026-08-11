import { SqliteTaskRouteStore } from "./sqlite.ts";
import type { TaskRouteStore } from "./interface.ts";

/**
 * Task routes live in the same SQLite file as memory v3 — they share the DB,
 * the embedding provider, and the archive-never-delete decay contract.
 */
export function createTaskRouteStore(dbPath = "data/memory.db"): TaskRouteStore {
  return new SqliteTaskRouteStore(dbPath);
}
