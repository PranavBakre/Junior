// Migration: prune routing_memory_decision_* nodes from the search index.
//
// These nodes were created by the old captureRoutingDecision() double-write bug.
// The raw evidence already lives in memory_source_record (kind = routing_decision).
// Only LEARNED routing patterns (routing_memory_<slug>, tagged learned_correction)
// should be searchable routing_memory nodes.
//
// DRY-RUN BY DEFAULT — prints what would be deleted, does nothing.
// Pass --apply to perform the deletes inside a transaction.
//
//   bun run migrate:prune-routing-logs
//   bun run migrate:prune-routing-logs --db data/memory.db --apply

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface PruneResult {
  targetCount: number;
  memory_fact: number;
  memory_node: number;
  memory_search_doc: number;
  memory_fts: number;
  memory_tag: number;
  mention: number;
  memory_provenance: number;
  edge: number;
}

/**
 * Core prune logic. Can be called directly from tests by passing a Database instance.
 *
 * @param db   Raw bun:sqlite Database (NOT SqliteMemoryStore — we want raw access).
 * @param opts apply=false => dry-run (count only), apply=true => execute deletes.
 * @returns    Counts of rows that were (or would be) deleted per table.
 */
export function pruneRoutingDecisionLogs(
  db: Database,
  opts: { apply: boolean },
): PruneResult {
  // Find all fact ids that match the old double-write pattern.
  const targets = db
    .query<{ id: string }, []>(
      "SELECT id FROM memory_fact WHERE id LIKE 'routing_memory_decision_%'",
    )
    .all()
    .map((row) => row.id);

  const targetCount = targets.length;

  if (targetCount === 0) {
    return {
      targetCount: 0,
      memory_fact: 0,
      memory_node: 0,
      memory_search_doc: 0,
      memory_fts: 0,
      memory_tag: 0,
      mention: 0,
      memory_provenance: 0,
      edge: 0,
    };
  }

  // Helper: count rows that would be deleted for a single id across a table.
  function countRows(table: string, column: string, id: string): number {
    const row = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`,
      )
      .get(id);
    return row?.c ?? 0;
  }

  function countEdgeRows(id: string): number {
    const row = db
      .query<{ c: number }, [string, string]>(
        "SELECT COUNT(*) AS c FROM edge WHERE src_id = ? OR dst_id = ?",
      )
      .get(id, id);
    return row?.c ?? 0;
  }

  // Tally per-table counts across all target ids.
  let memFact = 0;
  let memNode = 0;
  let memSearchDoc = 0;
  let memFts = 0;
  let memTag = 0;
  let mention = 0;
  let memProvenance = 0;
  let edge = 0;

  for (const id of targets) {
    memFact += countRows("memory_fact", "id", id);
    memNode += countRows("memory_node", "id", id);
    memSearchDoc += countRows("memory_search_doc", "id", id);
    memFts += countRows("memory_fts", "id", id);
    memTag += countRows("memory_tag", "memory_id", id);
    mention += countRows("mention", "memory_id", id);
    memProvenance += countRows("memory_provenance", "memory_id", id);
    edge += countEdgeRows(id);
  }

  if (!opts.apply) {
    return {
      targetCount,
      memory_fact: memFact,
      memory_node: memNode,
      memory_search_doc: memSearchDoc,
      memory_fts: memFts,
      memory_tag: memTag,
      mention,
      memory_provenance: memProvenance,
      edge,
    };
  }

  // Execute deletes inside a single transaction.
  const txn = db.transaction(() => {
    for (const id of targets) {
      db.query("DELETE FROM memory_tag WHERE memory_id = ?").run(id);
      db.query("DELETE FROM mention WHERE memory_id = ?").run(id);
      db.query("DELETE FROM memory_provenance WHERE memory_id = ?").run(id);
      db.query("DELETE FROM edge WHERE src_id = ? OR dst_id = ?").run(id, id);
      db.query("DELETE FROM memory_fts WHERE id = ?").run(id);
      db.query("DELETE FROM memory_search_doc WHERE id = ?").run(id);
      db.query("DELETE FROM memory_fact WHERE id = ?").run(id);
      db.query("DELETE FROM memory_node WHERE id = ?").run(id);
    }
  });
  txn();

  return {
    targetCount,
    memory_fact: memFact,
    memory_node: memNode,
    memory_search_doc: memSearchDoc,
    memory_fts: memFts,
    memory_tag: memTag,
    mention,
    memory_provenance: memProvenance,
    edge,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbIdx = args.indexOf("--db");
  const dbPath =
    dbIdx !== -1 && args[dbIdx + 1]
      ? args[dbIdx + 1]
      : (process.env.MEMORY_DB_PATH ?? "data/memory.db");

  if (!existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");

  try {
    const result = pruneRoutingDecisionLogs(db, { apply });

    if (result.targetCount === 0) {
      console.log("No routing_memory_decision_* rows found. Nothing to prune.");
      return;
    }

    const mode = apply ? "APPLY" : "DRY-RUN";
    console.log(`\n=== Prune routing_memory_decision_* [${mode}] ===`);
    console.log(`Target ids: ${result.targetCount}`);
    console.log(`\nRows ${apply ? "deleted" : "that would be deleted"} per table:`);
    console.log(`  memory_fact:       ${result.memory_fact}`);
    console.log(`  memory_node:       ${result.memory_node}`);
    console.log(`  memory_search_doc: ${result.memory_search_doc}`);
    console.log(`  memory_fts:        ${result.memory_fts}`);
    console.log(`  memory_tag:        ${result.memory_tag}`);
    console.log(`  mention:           ${result.mention}`);
    console.log(`  memory_provenance: ${result.memory_provenance}`);
    console.log(`  edge:              ${result.edge}`);

    if (!apply) {
      console.log(`\nRe-run with --apply to execute.\n`);
    } else {
      console.log(`\nPrune complete.\n`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
