import { SqliteMemoryStore } from "./sqlite.ts";
import type { MemoryStore } from "./store.ts";

export function createMemoryStore(dbPath = "data/memory.db"): MemoryStore {
  return new SqliteMemoryStore(dbPath);
}
