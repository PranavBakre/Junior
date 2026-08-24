// Read-only production-boundary evaluation: real claim writes + pre-recall read path.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryToolDeps } from "../mcp/slack-server.ts";
import { HashingEmbeddingProvider } from "./embedding/hashing.ts";
import { createProfileStore } from "./profiles/index.ts";
import { recallCandidates, selectFallbackCandidates, selectSynthesisCandidates } from "./pre-recall.ts";
import { SqliteMemoryStore } from "./sqlite.ts";

export interface HistoricalReplayCase {
  id: string;
  query: string;
  expectedClaimId: string;
  /** Stable answer-level label from a reviewed historical query. */
  useful: boolean;
}

export interface HistoricalReplayReport {
  cases: number;
  candidateRecallAt20: number;
  selectedUsefulRate: number;
  outcomes: Array<{ id: string; candidateIds: string[]; selectedIds: string[]; useful: boolean }>;
}

/** Executes against a disposable DB only; never opens or mutates MEMORY_DB_PATH. */
export async function runHistoricalReplay(
  corpus: Array<{ id: string; text: string; repo?: string | null; tags?: string[] }> ,
  cases: HistoricalReplayCase[],
): Promise<HistoricalReplayReport> {
  const root = await mkdtemp(join(tmpdir(), "junior-memory-replay-"));
  const store = new SqliteMemoryStore(join(root, "memory.db"));
  const embedder = new HashingEmbeddingProvider();
  const deps: MemoryToolDeps = { store, provider: embedder, profileStore: createProfileStore({ root: join(root, "profiles") }) };
  try {
    for (const claim of corpus) {
      const [embedding] = await embedder.embed([claim.text], "document");
      await store.upsertClaim({ id: claim.id, kind: "lesson", text: claim.text, retrievalText: claim.text, embedding, embedModel: embedder.model, dim: embedder.dim, repo: claim.repo ?? null, tags: claim.tags ?? [], createdAt: 1 });
    }
    const outcomes = [];
    for (const item of cases) {
      const candidates = await recallCandidates([item.query], { repo: null }, deps);
      const shortlist = selectSynthesisCandidates(candidates);
      const selected = selectFallbackCandidates(shortlist);
      outcomes.push({ id: item.id, candidateIds: candidates.map((x) => x.id), selectedIds: selected.map((x) => x.id), useful: item.useful && selected.some((x) => x.id === item.expectedClaimId) });
    }
    return {
      cases: cases.length,
      candidateRecallAt20: outcomes.filter((x, i) => x.candidateIds.includes(cases[i]!.expectedClaimId)).length / Math.max(1, cases.length),
      selectedUsefulRate: outcomes.filter((x) => x.useful).length / Math.max(1, cases.length),
      outcomes,
    };
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}
