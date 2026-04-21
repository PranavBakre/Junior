import { resolve } from "node:path";
import type { Config } from "../../config.ts";
import type { SessionStore } from "./interface.ts";
import { InMemorySessionStore } from "./memory.ts";
import { SqliteSessionStore } from "./sqlite.ts";

export function createSessionStore(config: Config): SessionStore {
  if (config.session.store === "memory") {
    return new InMemorySessionStore();
  }
  return new SqliteSessionStore(resolve(config.session.sqlitePath));
}
