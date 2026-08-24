import { expect, test } from "bun:test";
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
