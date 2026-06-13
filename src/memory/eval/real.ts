// Real-world recall eval against the live memory DB.
//
//   bun run memory:eval:real            # snapshot + run all available checks
//   bun run memory:eval:real sample 40  # emit a sample + paraphrase template
//
// SAFETY: recall() writes use_count, so we never touch data/memory.db directly.
// We VACUUM INTO a throwaway snapshot and run everything against that copy.
//
// Two layers of test:
//   1. LLM-free (always runs): index self-retrieval health, real recall latency,
//      and broad-tag stress on the real tag cardinality. A genuine real-world
//      test of the performance + index-integrity claims.
//   2. Known-item paraphrase eval (runs if data/evals/known-item-queries.json
//      exists): the real paraphrase-miss rate — the quality number that decides
//      whether vectors (Phase 4) are worth building. Each entry is
//      {id, query} where `query` is a low-lexical-overlap paraphrase whose
//      answer is memory `id`. Generate it with any LLM (see `sample` subcommand).

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../sqlite.ts";
import type { EvalCase } from "./corpus.ts";
import { runEval } from "./harness.ts";
import { firstRelevantRank, percentile } from "./metrics.ts";

const SOURCE_DB = process.env.MEMORY_DB_PATH ?? "data/memory.db";
const QUERIES_FILE = "data/evals/known-item-queries.json";
const SAMPLE_FILE = "data/evals/known-item-sample.json";
const REPORT_FILE = "data/evals/real-report.json";
const RECALL_KINDS = ["lesson", "routing_memory", "procedure", "fact"];

const STOPWORDS = new Set(
  "the a an and or but to of in on for with at by from is are was were be been it this that these those as into your you we i our should not no do does how what when which".split(" "),
);

type MemRow = { id: string; kind: string; title: string | null; body: string };

function snapshot(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "junior-mem-snap-"));
  const path = join(dir, "memory.db");
  const src = new Database(SOURCE_DB);
  src.run("PRAGMA busy_timeout = 8000");
  src.run(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  src.close();
  return { dir, path };
}

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** A realistic in-vocabulary query built from a memory's own content words. */
function selfQuery(body: string, n = 8): string {
  return contentTokens(body).slice(0, n).join(" ");
}

function sampleMemories(db: Database, perKind: number): MemRow[] {
  const out: MemRow[] = [];
  for (const kind of RECALL_KINDS) {
    const rows = db
      .query<MemRow, [string, number]>(
        `SELECT d.id, d.kind, d.title, d.body
         FROM memory_search_doc d
         JOIN memory_node n ON n.id = d.id
         WHERE d.kind = ? AND n.invalid_at IS NULL AND n.superseded_by IS NULL
         ORDER BY d.updated_at DESC
         LIMIT ?`,
      )
      .all(kind, perKind);
    out.push(...rows);
  }
  return out;
}

function topTag(db: Database): { tag: string; count: number } | null {
  const row = db
    .query<{ tag_id: string; c: number }, []>(
      "SELECT tag_id, count(*) c FROM memory_tag GROUP BY tag_id ORDER BY c DESC LIMIT 1",
    )
    .get();
  if (!row) return null;
  return { tag: row.tag_id.replace(/^tag:/, ""), count: row.c };
}

function fmtMs(n: number): string {
  return `${n.toFixed(2)}ms`;
}

async function runSampleCommand(perKind: number): Promise<void> {
  const { dir, path } = snapshot();
  try {
    const db = new Database(path, { readonly: true });
    const sample = sampleMemories(db, perKind);
    db.close();
    mkdirSync("data/evals", { recursive: true });
    writeFileSync(SAMPLE_FILE, JSON.stringify(sample, null, 2));
    const template = sample.map((m) => ({ id: m.id, query: "" }));
    if (!existsSync(QUERIES_FILE)) {
      writeFileSync(QUERIES_FILE, JSON.stringify(template, null, 2));
    }
    console.log(`Sampled ${sample.length} memories -> ${SAMPLE_FILE}`);
    console.log(`Paraphrase template -> ${QUERIES_FILE} (fill each "query" with a low-overlap paraphrase, then run \`bun run memory:eval:real\`).`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runReport(perKind: number): Promise<void> {
  const { dir, path } = snapshot();
  const store = new SqliteMemoryStore(path);
  const ro = new Database(path, { readonly: true });
  try {
    const totals = ro.query<{ c: number }, []>("SELECT count(*) c FROM memory_search_doc").get();
    const sample = sampleMemories(ro, perKind);

    console.log("\n=== Real-World Recall Eval ===");
    console.log(`snapshot of ${SOURCE_DB}: ${totals?.c ?? 0} searchable memories`);
    console.log(`sample: ${sample.length} recall-worthy memories (${RECALL_KINDS.join("/")})`);

    // --- LLM-free: self-retrieval health + real latency ----------------------
    const selfRanks: Array<number | null> = [];
    const latencies: number[] = [];
    for (const m of sample) {
      const q = selfQuery(m.body);
      if (!q) continue;
      const start = performance.now();
      const results = await store.recall({ query: q, limit: 5, recordUsage: false });
      latencies.push(performance.now() - start);
      selfRanks.push(firstRelevantRank(results.map((r) => r.id), new Set([m.id])));
    }
    const selfHit1 = selfRanks.filter((r) => r === 1).length / selfRanks.length;
    const selfHit5 = selfRanks.filter((r) => r !== null && r <= 5).length / selfRanks.length;
    console.log(`\nindex self-retrieval (query = memory's own content words):`);
    console.log(`  self-hit@1=${(selfHit1 * 100).toFixed(0)}%  self-hit@5=${(selfHit5 * 100).toFixed(0)}%  (n=${selfRanks.length})`);
    console.log(`  -> below 100% means another memory outranks an exact-term self match (real ranking signal)`);
    console.log(`\nreal recall latency: p50=${fmtMs(percentile(latencies, 50))}  p95=${fmtMs(percentile(latencies, 95))}  max=${fmtMs(Math.max(0, ...latencies))}  (n=${latencies.length})`);

    // --- LLM-free: broad-tag stress on real cardinality ----------------------
    const tag = topTag(ro);
    if (tag) {
      const tagLat: number[] = [];
      let count = 0;
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const results = await store.recall({ tags: [tag.tag], depth: 2, limit: 5, recordUsage: false });
        tagLat.push(performance.now() - start);
        count = results.length;
      }
      console.log(`\nbroad-tag stress: tag="${tag.tag}" attached to ${tag.count} memories`);
      console.log(`  results=${count}  p50=${fmtMs(percentile(tagLat, 50))}  p95=${fmtMs(percentile(tagLat, 95))}  max=${fmtMs(Math.max(0, ...tagLat))}`);
    }

    // --- Known-item paraphrase eval (if queries provided) --------------------
    let paraphrase: unknown = null;
    if (existsSync(QUERIES_FILE)) {
      const entries = JSON.parse(readFileSync(QUERIES_FILE, "utf8")) as Array<{ id: string; query: string }>;
      const cases: EvalCase[] = entries
        .filter((e) => e.query && e.query.trim().length > 0)
        .map((e, i) => ({ id: `known-item-${i}`, category: "paraphrase", query: e.query, relevantIds: [e.id], note: "real known-item paraphrase" }));
      if (cases.length === 0) {
        console.log(`\nknown-item: ${QUERIES_FILE} has no filled queries yet. Run \`bun run memory:eval:real sample\` then fill it.`);
      } else {
        const stats = { memories: totals?.c ?? 0, edges: 0, stressTag: tag?.tag ?? "", stressTagged: tag?.count ?? 0 };
        const report = await runEval(store, cases, stats);
        paraphrase = report;
        const d = report.decomposition;
        console.log(`\nknown-item paraphrase eval (${report.scoredCases} real queries):`);
        console.log(`  hit@1=${(report.overall.hitAt1 * 100).toFixed(0)}%  hit@5=${(report.overall.hitAt5 * 100).toFixed(0)}%  MRR=${report.overall.mrr.toFixed(3)}`);
        console.log(`  decomposition: ${d.hits} hits / ${d.rankingGaps} ranking-gaps / ${d.retrievalGaps} retrieval-gaps`);
        console.log(`  -> retrieval-gaps are the paraphrase misses vectors would target; ranking-gaps are scoring fixes`);
      }
    } else {
      console.log(`\nknown-item: no ${QUERIES_FILE}. Run \`bun run memory:eval:real sample\` to generate a paraphrase template.`);
    }

    mkdirSync("data/evals", { recursive: true });
    writeFileSync(
      REPORT_FILE,
      JSON.stringify({ source: SOURCE_DB, totalMemories: totals?.c ?? 0, sampleSize: sample.length, selfHit1, selfHit5, latencyP50: percentile(latencies, 50), latencyP95: percentile(latencies, 95), paraphrase }, null, 2),
    );
    console.log(`\nfull report -> ${REPORT_FILE}\n`);
  } finally {
    ro.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "sample") {
    await runSampleCommand(Number(arg) || 10);
  } else {
    await runReport(Number(arg) || 15);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
