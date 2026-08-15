import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { UsageStore } from "./interface.ts";
import { InMemoryUsageStore } from "./memory.ts";
import { SqliteUsageStore } from "./sqlite.ts";

export type UsageStoreOptions = {
  kind?: "memory" | "sqlite";
  sqlitePath?: string;
  db?: Database;
};

export function createUsageStore(
  options: UsageStoreOptions = {},
): UsageStore {
  const kind = options.kind ?? (options.db ? "sqlite" : "memory");
  if (kind === "memory") return new InMemoryUsageStore();
  if (options.db) return new SqliteUsageStore(options.db);
  return new SqliteUsageStore(resolve(options.sqlitePath ?? "data/sessions.db"));
}
