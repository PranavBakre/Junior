import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { DashboardAuditStore } from "./interface.ts";
import { InMemoryDashboardAuditStore } from "./memory.ts";
import { SqliteDashboardAuditStore } from "./sqlite.ts";

export type DashboardAuditStoreOptions = {
  kind?: "memory" | "sqlite";
  sqlitePath?: string;
  db?: Database;
};

export function createDashboardAuditStore(
  options: DashboardAuditStoreOptions = {},
): DashboardAuditStore {
  const kind = options.kind ?? (options.db ? "sqlite" : "memory");
  if (kind === "memory") return new InMemoryDashboardAuditStore();
  if (options.db) return new SqliteDashboardAuditStore(options.db);
  return new SqliteDashboardAuditStore(
    resolve(options.sqlitePath ?? "data/sessions.db"),
  );
}
