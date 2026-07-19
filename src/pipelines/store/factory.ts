import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { Clock } from "../../time/clock.ts";
import { systemClock } from "../../time/clock.ts";
import type { PipelineStore } from "./interface.ts";
import { InMemoryPipelineStore } from "./memory.ts";
import { SqlitePipelineStore } from "./sqlite.ts";

export type PipelineStoreOptions = {
  kind?: "memory" | "sqlite";
  /** Path used when kind is sqlite and no shared Database is provided. */
  sqlitePath?: string;
  /** Optional shared bun:sqlite Database (e.g. sessions DB). */
  db?: Database;
  clock?: Clock;
};

/**
 * Create a pipeline store. Defaults to in-memory for tests; production
 * callers pass kind="sqlite" and the configured session DB path (or a
 * shared Database handle).
 */
export function createPipelineStore(
  options: PipelineStoreOptions = {},
): PipelineStore {
  const clock = options.clock ?? systemClock;
  const kind = options.kind ?? (options.db ? "sqlite" : "memory");
  if (kind === "memory") {
    return new InMemoryPipelineStore(clock);
  }
  if (options.db) {
    return new SqlitePipelineStore(options.db, clock);
  }
  const path = resolve(options.sqlitePath ?? "data/sessions.db");
  return new SqlitePipelineStore(path, clock);
}
