import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHistoricalReplay } from "./historical-replay.ts";

test("historical replay exercises real claim upsert and pre-recall candidate/selection boundaries", async () => {
  const report = await runHistoricalReplay([
    { id: "scope", text: "When a checkout is already dirty, preserve unrelated work and limit edits to assigned files." },
    { id: "backup", text: "Before an irreversible database migration, create and verify a recoverable backup." },
    { id: "noise", text: "Use UTC timestamps for persisted instants." },
  ], [{ id: "historical-dirty-checkout", query: "When a checkout is already dirty, preserve unrelated work and limit edits to assigned files.", expectedClaimId: "scope", useful: true }]);
  expect(report.candidateRecallAt20).toBe(1);
  expect(report.selectedUsefulRate).toBe(1);
  expect(report.outcomes[0]!.selectedIds).toContain("scope");
});

test("replay applies repo/global and trusted-tag production filters with positive and negative labels", async () => {
  const report = await runHistoricalReplay([
    { id: "global", text: "Use a recoverable backup before an irreversible migration.", tags: ["safe"] },
    { id: "repo-a", text: "Repo A deployment uses the blue release lane.", repo: "a", tags: ["release"] },
    { id: "repo-b", text: "Repo B deployment uses the green release lane.", repo: "b", tags: ["release"] },
  ], [
    { id: "global-in-a", query: "Use a recoverable backup before an irreversible migration.", expectedClaimId: "global", repo: "a", trustedTags: ["safe"], useful: true },
    { id: "wrong-tag-negative", query: "Repo A deployment uses the blue release lane.", expectedClaimId: "repo-a", repo: "a", trustedTags: ["safe"], useful: false },
  ]);
  expect(report.outcomes[0]!.candidateIds).toEqual(["global"]);
  expect(report.outcomes[1]!.candidateIds).toEqual(["global"]);
  expect(report.outcomes[1]!.selectedIds).not.toContain("repo-a");
  expect(report.selectedUsefulRate).toBe(0.5);
});

test("replay enforces recall top-k and fallback floor without touching production MEMORY_DB_PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "junior-memory-replay-production-"));
  const productionPath = join(root, "production-memory.db");
  const production = new Database(productionPath);
  production.run("CREATE TABLE sentinel (value TEXT)");
  production.run("INSERT INTO sentinel VALUES ('unchanged')");
  production.close();
  const before = readFileSync(productionPath);
  const old = process.env.MEMORY_DB_PATH;
  process.env.MEMORY_DB_PATH = productionPath;
  try {
    const corpus = Array.from({ length: 25 }, (_, index) => ({
      id: `claim-${index}`,
      text: index === 24 ? "Exact stable replay target for top k selection." : `Unrelated replay candidate ${index}.`,
    }));
    const report = await runHistoricalReplay(corpus, [
      { id: "top-k", query: "Exact stable replay target for top k selection.", expectedClaimId: "claim-24", useful: true },
      { id: "floor-negative", query: "utterly unrelated vocabulary with no overlap", expectedClaimId: "claim-0", useful: false },
    ]);
    expect(report.outcomes[0]!.candidateIds).toHaveLength(20);
    expect(report.outcomes[0]!.selectedIds.length).toBeLessThanOrEqual(3);
    expect(report.outcomes[0]!.selectedIds).toContain("claim-24");
    expect(report.outcomes[1]!.selectedIds).toEqual([]);
    expect(readFileSync(productionPath)).toEqual(before);
  } finally {
    if (old === undefined) delete process.env.MEMORY_DB_PATH;
    else process.env.MEMORY_DB_PATH = old;
    rmSync(root, { recursive: true, force: true });
  }
});
