// CLI: seed the synthetic corpus, run the recall eval, print a report.
//
//   bun run src/memory/eval/run.ts
//
// Use this to quantify recall quality and latency *before* building any phase
// of the memory overhaul, and to re-measure after each phase lands.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../sqlite.ts";
import { seedEvalCorpus, STRESS_TAG } from "./corpus.ts";
import { measureBroadTagStress, runEval, type EvalReport } from "./harness.ts";

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function ms(n: number): string {
  return `${n.toFixed(2)}ms`;
}

function printReport(report: EvalReport, stress: Awaited<ReturnType<typeof measureBroadTagStress>>): void {
  const { meta, overall, decomposition } = report;
  console.log("\n=== Memory Recall Eval (synthetic baseline) ===");
  console.log(
    `corpus: ${meta.corpus.memories} memories, ${meta.corpus.edges} edges, ` +
      `${meta.corpus.stressTagged} rows on tag "${meta.corpus.stressTag}"`,
  );
  console.log(
    `config: rankedLimit=${meta.rankedLimit} candidateLimit=${meta.candidateLimit} k=${meta.k} ` +
      `writeback=${meta.writebackMode}`,
  );

  console.log(`\noverall (${report.scoredCases} scored cases):`);
  console.log(`  hit@1=${pct(overall.hitAt1)}  hit@5=${pct(overall.hitAt5)}  recall@5=${pct(overall.recallAt5)}  MRR=${overall.mrr.toFixed(3)}`);
  console.log(
    `  decomposition: ${decomposition.hits} hits / ${decomposition.rankingGaps} ranking-gaps / ${decomposition.retrievalGaps} retrieval-gaps`,
  );
  console.log(`  forbidden violations: ${report.forbiddenViolations}`);

  console.log("\nby category:");
  console.log("  category      cases  hit@1  hit@5  recall@5  MRR    retr-gap  rank-gap  forbid");
  for (const c of report.byCategory) {
    console.log(
      `  ${c.category.padEnd(12)}  ${String(c.cases).padStart(5)}  ${pct(c.hitAt1).padStart(5)}  ${pct(c.hitAt5).padStart(5)}  ` +
        `${pct(c.recallAt5).padStart(8)}  ${c.mrr.toFixed(2).padStart(5)}  ${String(c.retrievalGaps).padStart(8)}  ${String(c.rankingGaps).padStart(8)}  ${String(c.forbiddenViolations).padStart(6)}`,
    );
  }

  console.log("\nlatency (ranked recall):");
  console.log(`  p50=${ms(report.latency.p50)}  p95=${ms(report.latency.p95)}  max=${ms(report.latency.max)}  n=${report.latency.samples}`);

  console.log("\nbroad-tag stress (the hot-path weak spot):");
  console.log(`  tag="${stress.tag}" results=${stress.resultCount}  p50=${ms(stress.p50)}  p95=${ms(stress.p95)}  max=${ms(stress.max)}`);

  console.log("\nretrieval gaps (motivate semantic recall):");
  for (const r of report.perCase.filter((x) => x.gap === "retrieval_gap")) {
    console.log(`  [${r.category}] ${r.id}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "junior-recall-eval-"));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  try {
    const { cases, stats } = await seedEvalCorpus(store, Date.now());
    const report = await runEval(store, cases, stats);
    const stress = await measureBroadTagStress(store, STRESS_TAG);
    printReport(report, stress);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
