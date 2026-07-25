import { SqliteMemoryStore, type SqliteMemoryStoreOptions } from "./sqlite.ts";
import type { MemoryStore } from "./store.ts";

export function createMemoryStore(
  dbPath = "data/memory.db",
  options: SqliteMemoryStoreOptions = {},
): MemoryStore {
  return new SqliteMemoryStore(dbPath, options);
}
