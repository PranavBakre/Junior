/**
 * memory v3 migration — lesson + memory_fact → claim, then drop the
 * audit-condemned piles (docs/features/memory-system-v3.md §2, §6.3).
 *
 * This is a COMMITTED, OFFLINE migration script. Per CLAUDE.md
 * (no-prod-db-before-code): never hand-edit the live DB. Run this against a
 * COPY of memory.db, verify the eval gate, then cut over. The destructive part
 * (dropping tables) is gated behind `apply: true`; the default is a DRY RUN
 * that computes and reports everything but mutates nothing.
 *
 * Lane discipline: this module owns ONLY migrate-v3.ts / migrate-v3.test.ts.
 * It consumes the store's PUBLIC API (`createMemoryStore`, `upsertClaim`) for
 * the schema + BLOB-serialize, and uses its OWN bun:sqlite handle purely for
 * raw reads of the legacy tables and the apply-gated DROPs.
 */
import { Database } from "bun:sqlite";
import { createMemoryStore } from "./factory.ts";
import { createEmbeddingProvider } from "./embedding/factory.ts";
import type { EmbeddingProvider } from "./embedding/types.ts";
import type { ClaimKind } from "./types.ts";

/** Tables the audit condemned (§2 / §6.3-step-1) — dropped only when applying. */
const CONDEMNED_TABLES = [
  "memory_event",
  "edge",
  "mention",
  "memory_search_doc",
  "candidate_rule",
] as const;

export interface MigrateV3Options {
  /** Path to the memory SQLite DB. NEVER defaulted — caller must be explicit. */
  dbPath: string;
  /** Embedding provider. Use the local (harrier) provider at real cutover. */
  provider: EmbeddingProvider;
  /**
   * Destructive switch. `false` (default) = DRY RUN: nothing is written and
   * nothing is dropped. `true` = write surviving claims AND drop condemned
   * tables. Guarded hard everywhere a mutation could happen.
   */
  apply?: boolean;
  /** Cosine threshold for proximity dedup; pairs >= this collapse. Default 0.95. */
  dedupeThreshold?: number;
}

export interface MigrateV3Report {
  /** Number of `lesson` rows read. */
  lessons: number;
  /** Number of `memory_fact` rows read. */
  facts: number;
  /** Number of claim texts embedded (== lessons + facts). */
  embedded: number;
  /** Surviving claims actually persisted to the store (0 on a dry run). */
  claimsWritten: number;
  /** How many claims were folded away by proximity dedup (raw − survivors). */
  duplicatesMerged: number;
  /** Condemned tables actually dropped (empty on a dry run). */
  tablesDropped: string[];
  /** Whether the destructive path ran. */
  applied: boolean;
}

/** A claim derived from a legacy lesson/fact row, with its embedding. */
interface RawClaim {
  id: string;
  kind: ClaimKind;
  text: string;
  tags: string[];
  weight: number;
  createdAt: number;
  active: boolean;
  vector: Float32Array;
}

type LegacyLessonRow = {
  id: string;
  title: string;
  body: string;
  importance: number | null;
  created_at: number;
  active: number | null;
};

type LegacyFactRow = {
  id: string;
  title: string | null;
  body: string;
  importance: number | null;
  created_at: number;
  active: number | null;
};

/**
 * Run the v3 backfill + (apply-gated) condemned-table drop.
 *
 * Safe to point at ANY path — there is no hardcoded data/memory.db, and the
 * only destructive operations (claim writes, table drops) are gated on `apply`.
 */
export async function migrateV3(opts: MigrateV3Options): Promise<MigrateV3Report> {
  const { dbPath, provider } = opts;
  const apply = opts.apply === true;
  const dedupeThreshold = opts.dedupeThreshold ?? 0.95;

  if (!dbPath) throw new Error("migrateV3: dbPath is required");

  // Opening through the store ensures the v3 `claim` schema exists (and reuses
  // the store's node/FTS/BLOB wiring on write). Our own raw handle is for the
  // legacy reads + the apply-gated drops.
  const store = createMemoryStore(dbPath);
  const db = new Database(dbPath);

  try {
    // 1. Read the legacy rows (raw SQL on our own handle).
    const lessonRows = db
      .query(
        "SELECT id, title, body, importance, created_at, active FROM lesson",
      )
      .all() as LegacyLessonRow[];
    const factRows = db
      .query(
        "SELECT id, title, body, importance, created_at, active FROM memory_fact",
      )
      .all() as LegacyFactRow[];

    // Tags live in memory_tag ⋈ tag (not on the lesson/fact row itself).
    const tagStmt = db.query(
      "SELECT t.name AS name FROM memory_tag mt JOIN tag t ON t.id = mt.tag_id WHERE mt.memory_id = ?",
    );
    const tagsFor = (memoryId: string): string[] =>
      unique(
        (tagStmt.all(memoryId) as Array<{ name: string }>).map((r) => r.name),
      );

    // 2 + 3. Build claim texts (carry tags, map importance→weight, set kind)
    //        and embed each ONE AT A TIME (the local provider embeds per-text;
    //        keeping calls size-1 mirrors that and stays deterministic).
    const raw: RawClaim[] = [];

    for (const row of lessonRows) {
      const text = `${row.title}\n${row.body}`;
      const [vector] = await provider.embed([text], "document");
      raw.push({
        id: row.id,
        kind: "lesson",
        text,
        tags: tagsFor(row.id),
        weight: toWeight(row.importance),
        createdAt: row.created_at,
        active: row.active !== 0,
        vector,
      });
    }

    for (const row of factRows) {
      const text = row.title ? `${row.title}\n${row.body}` : row.body;
      const [vector] = await provider.embed([text], "document");
      raw.push({
        id: row.id,
        kind: "fact",
        text,
        tags: tagsFor(row.id),
        weight: toWeight(row.importance),
        createdAt: row.created_at,
        active: row.active !== 0,
        vector,
      });
    }

    // 4. Proximity dedup: greedy single-link clustering by cosine >= threshold.
    //    Within a cluster keep the highest-weight claim, union tags, drop rest.
    const survivors = dedupeClaims(raw, dedupeThreshold);
    const duplicatesMerged = raw.length - survivors.length;

    // 5. Write surviving claims — APPLY-GATED. A dry run mutates nothing.
    let claimsWritten = 0;
    if (apply) {
      for (const s of survivors) {
        await store.upsertClaim({
          id: s.id,
          kind: s.kind,
          text: s.text,
          embedding: s.vector,
          embedModel: provider.model,
          dim: provider.dim,
          tags: s.tags,
          weight: s.weight,
          createdAt: s.createdAt,
          active: s.active,
        });
        claimsWritten++;
      }
    }

    // Release the store handle before any DROP so the two connections don't
    // contend for the write lock.
    store.close();

    // 6. Drop the condemned tables — APPLY-GATED, never in a dry run.
    const tablesDropped: string[] = [];
    if (apply) {
      for (const table of CONDEMNED_TABLES) {
        if (tableExists(db, table)) {
          db.run(`DROP TABLE IF EXISTS ${table}`);
          tablesDropped.push(table);
        }
      }
    }

    db.close();

    // 7. Report.
    return {
      lessons: lessonRows.length,
      facts: factRows.length,
      embedded: raw.length,
      claimsWritten,
      duplicatesMerged,
      tablesDropped,
      applied: apply,
    };
  } catch (err) {
    // Best-effort cleanup; a half-open store handle must not leak.
    try {
      store.close();
    } catch {
      /* already closed */
    }
    try {
      db.close();
    } catch {
      /* already closed */
    }
    throw err;
  }
}

/** importance (REAL, may be null) → claim weight. Identity, with a 1.0 floor default. */
function toWeight(importance: number | null): number {
  return typeof importance === "number" ? importance : 1.0;
}

/** Cosine similarity. Provider vectors are L2-normalized, but we don't assume it. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Greedy single-link clustering: for each not-yet-clustered claim, absorb every
 * remaining claim within `threshold` cosine. Keep the highest-weight member,
 * union all tags, drop the rest. Order-dependent but adequate for an offline,
 * one-shot dedup pass (§6.3-step-4).
 */
function dedupeClaims(raw: RawClaim[], threshold: number): RawClaim[] {
  const survivors: RawClaim[] = [];
  const used = new Array(raw.length).fill(false);

  for (let i = 0; i < raw.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const cluster = [raw[i]];
    for (let j = i + 1; j < raw.length; j++) {
      if (used[j]) continue;
      if (cosine(raw[i].vector, raw[j].vector) >= threshold) {
        used[j] = true;
        cluster.push(raw[j]);
      }
    }
    // Keep the highest-weight member as the survivor; union tags across cluster.
    let best = cluster[0];
    for (const c of cluster) if (c.weight > best.weight) best = c;
    const mergedTags = unique(cluster.flatMap((c) => c.tags));
    survivors.push({ ...best, tags: mergedTags, weight: best.weight });
  }

  return survivors;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row != null;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// --------------------------------------------------------------------------
// CLI entrypoint — `bun src/memory/migrate-v3.ts --db <path> [--apply] [...]`
//
// Requires an explicit `--db <path>` and an explicit `--apply` to do anything
// destructive. Without `--apply` it is a dry run. Default provider is `local`
// (harrier) — the one that gives real *semantic* dedup at cutover.
// --------------------------------------------------------------------------
if (import.meta.main) {
  void runCli();
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const dbPath = readFlagValue(args, "--db");
  if (!dbPath) {
    console.error("error: --db <path> is required\n");
    printUsage();
    process.exit(1);
  }

  const apply = args.includes("--apply");
  const thresholdRaw = readFlagValue(args, "--threshold");
  const dedupeThreshold = thresholdRaw != null ? Number(thresholdRaw) : undefined;
  if (dedupeThreshold != null && !Number.isFinite(dedupeThreshold)) {
    console.error(`error: --threshold must be a number, got "${thresholdRaw}"`);
    process.exit(1);
  }

  const providerKind = (readFlagValue(args, "--provider") ?? "local") as
    | "local"
    | "hashing";
  if (providerKind !== "local" && providerKind !== "hashing") {
    console.error(`error: --provider must be "local" or "hashing"`);
    process.exit(1);
  }

  const provider = createEmbeddingProvider(providerKind);

  console.error(
    `migrate-v3: db=${dbPath} provider=${providerKind} apply=${apply} ` +
      `threshold=${dedupeThreshold ?? 0.95}`,
  );
  if (!apply) {
    console.error("DRY RUN — nothing will be written or dropped. Pass --apply to commit.");
  }

  const report = await migrateV3({ dbPath, provider, apply, dedupeThreshold });
  console.log(JSON.stringify(report, null, 2));
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value == null || value.startsWith("--")) return undefined;
  return value;
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun src/memory/migrate-v3.ts --db <path> [--apply] [--threshold <n>] [--provider local|hashing]",
      "",
      "  --db <path>            Path to the memory SQLite DB (run against a COPY). Required.",
      "  --apply                Commit: write claims AND drop condemned tables. Omit for a dry run.",
      "  --threshold <n>        Proximity-dedup cosine threshold (default 0.95).",
      "  --provider local|hashing   Embedding provider (default local / harrier).",
    ].join("\n"),
  );
}
