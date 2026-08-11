import { LocalEmbeddingProvider } from "./embedding/local.ts";
import {
  buildSynthesisPrompt,
  codexRunText,
  deriveRecallQueries,
  parseSynthesisResult,
  type SynthesisCandidate,
} from "./pre-recall.ts";
import { queryHasExactLexicalAnchor } from "./sqlite.ts";
import {
  lessonRetrievalFixtures as fixtures,
  type LessonRetrievalFixture as Fixture,
} from "./lesson-retrieval-benchmark-fixtures.ts";

type Variant =
  | "raw_lesson"
  | "single_question_plus_lesson"
  | "multi_question_only"
  | "multi_question_plus_lesson";

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index]! * right[index]!;
  return dot;
}

function terms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((term) => term.length > 2),
  );
}

function lexicalScore(query: string, document: string): number {
  const queryTerms = terms(query);
  const documentTerms = terms(document);
  let overlap = 0;
  for (const term of queryTerms) if (documentTerms.has(term)) overlap += 1;
  return overlap / Math.max(1, queryTerms.size);
}

function ranks(scores: number[]): number[] {
  const order = scores.map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const result = new Array<number>(scores.length);
  order.forEach((entry, rank) => result[entry.index] = rank + 1);
  return result;
}

function retrievalTexts(fixture: Fixture, variant: Variant): string[] {
  if (variant === "raw_lesson") return [`${fixture.title}\n${fixture.lesson}`];
  const cues = variant === "single_question_plus_lesson"
    ? fixture.questionCues.slice(0, 1)
    : fixture.questionCues;
  if (variant === "multi_question_only") return cues;
  return cues.map((cue) =>
    `${fixture.title}\nUse this lesson when: ${cue}\n${fixture.lesson}`
  );
}

const provider = new LocalEmbeddingProvider();
const variants: Variant[] = [
  "raw_lesson",
  "single_question_plus_lesson",
  "multi_question_only",
  "multi_question_plus_lesson",
];
const startedAt = performance.now();
const queryTextsByFixture = fixtures.map((fixture) =>
  deriveRecallQueries(fixture.query, { agent: "Junior" })
);
const flattenedQueryTexts = queryTextsByFixture.flat();
const flattenedQueryVectors = await provider.embed(flattenedQueryTexts, "query");
let queryOffset = 0;
const queryVectorsByFixture = queryTextsByFixture.map((queries) => {
  const vectors = flattenedQueryVectors.slice(queryOffset, queryOffset + queries.length);
  queryOffset += queries.length;
  return vectors;
});
const documentVectors = new Map<Variant, Float32Array[][]>();
for (const variant of variants) {
  const textsByFixture = fixtures.map((fixture) => retrievalTexts(fixture, variant));
  const flattened = textsByFixture.flat();
  const vectors = await provider.embed(flattened, "document");
  let offset = 0;
  documentVectors.set(variant, textsByFixture.map((texts) => {
    const group = vectors.slice(offset, offset + texts.length);
    offset += texts.length;
    return group;
  }));
}

const systems = variants.flatMap((variant) => [
  { name: `vector-single:${variant}`, variant, expanded: false, lexical: "never" as const },
  { name: `vector-expanded:${variant}`, variant, expanded: true, lexical: "never" as const },
  { name: `hybrid-unconditional:${variant}`, variant, expanded: true, lexical: "always" as const },
  { name: `hybrid-conditional:${variant}`, variant, expanded: true, lexical: "conditional" as const },
]);
const reports = systems.map((system) => {
  const outcomes = fixtures.map((fixture, queryIndex) => {
    const queryVectors = system.expanded
      ? queryVectorsByFixture[queryIndex]!
      : queryVectorsByFixture[queryIndex]!.slice(0, 1);
    const vectorScores = documentVectors.get(system.variant)!.map((vectors) =>
      Math.max(...queryVectors.flatMap((queryVector) =>
        vectors.map((vector) => cosine(queryVector, vector))
      ))
    );
    const lexicalScores = fixtures.map((candidate) =>
      Math.max(...retrievalTexts(candidate, system.variant).map((text) =>
        lexicalScore(fixture.query, text)
      ))
    );
    const vectorRanks = ranks(vectorScores);
    const lexicalRanks = ranks(lexicalScores);
    const fuseLexical = system.lexical === "always" ||
      (system.lexical === "conditional" && queryHasExactLexicalAnchor(fixture.query));
    const scores = fuseLexical
      ? vectorRanks.map((rank, index) =>
        1 / (60 + rank) +
        (lexicalScores[index]! > 0 ? 1 / (60 + lexicalRanks[index]!) : 0)
      )
      : vectorScores;
    const finalRanks = ranks(scores);
    const correctRank = finalRanks[queryIndex]!;
    const winnerIndex = finalRanks.indexOf(1);
    return {
      id: fixture.id,
      correctRank,
      winner: fixtures[winnerIndex]!.id,
    };
  });
  return {
    system: system.name,
    recallAt1: outcomes.filter((outcome) => outcome.correctRank === 1).length / outcomes.length,
    recallAt5: outcomes.filter((outcome) => outcome.correctRank <= 5).length / outcomes.length,
    candidateRecallAt20:
      outcomes.filter((outcome) => outcome.correctRank <= 20).length / outcomes.length,
    meanReciprocalRank: outcomes.reduce((sum, outcome) => sum + 1 / outcome.correctRank, 0) / outcomes.length,
    outcomes,
  };
});

const modelReranker = process.env.BENCHMARK_RERANKER === "1"
  ? await benchmarkModelReranker()
  : null;

const queryCueOverlaps = fixtures.map((fixture) =>
  Math.max(...fixture.questionCues.map((cue) => lexicalScore(fixture.query, cue)))
);

console.log(JSON.stringify({
  benchmark: "mock lesson retrieval cue comparison",
  caveat: "Hand-labelled synthetic set; validate the winner on historical Junior queries before changing production retrieval text.",
  model: provider.model,
  fixtureCount: fixtures.length,
  queryBlur: {
    averageMaximumLexicalOverlapWithOwnCues:
      queryCueOverlaps.reduce((sum, overlap) => sum + overlap, 0) / queryCueOverlaps.length,
    queriesWithNoSharedTerms: queryCueOverlaps.filter((overlap) => overlap === 0).length,
  },
  elapsedMs: performance.now() - startedAt,
  modelReranker,
  reports: process.env.BENCHMARK_VERBOSE === "1"
    ? reports
    : reports.map(({ outcomes: _outcomes, ...report }) => report),
}, null, 2));

async function benchmarkModelReranker() {
  const rerankerStartedAt = performance.now();
  const reasoningEffort = process.env.BENCHMARK_RERANK_REASONING_EFFORT ?? "medium";
  const vectorsByLesson = documentVectors.get("multi_question_plus_lesson")!;
  type RerankOutcome = {
    id: string;
    correctRank: number;
    selected: number;
    candidatePresent: boolean;
    failed: boolean;
  };
  const outcomes = new Array<RerankOutcome>(fixtures.length);
  let nextQueryIndex = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    while (true) {
      const queryIndex = nextQueryIndex;
      nextQueryIndex += 1;
      if (queryIndex >= fixtures.length) return;
      const fixture = fixtures[queryIndex]!;
      const queryVectors = queryVectorsByFixture[queryIndex]!.slice(0, 1);
      const scored = fixtures.map((candidate, candidateIndex) => ({
        candidate,
        score: Math.max(...queryVectors.flatMap((queryVector) =>
          vectorsByLesson[candidateIndex]!.map((vector) => cosine(queryVector, vector))
        )),
      })).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
      const shortlist: SynthesisCandidate[] = scored.slice(0, 20).map(({ candidate, score }) => ({
        id: candidate.id,
        text: `${candidate.title}\n${candidate.lesson}`,
        kind: "lesson",
        factKind: null,
        score,
        cosine: score,
        lexicalScore: null,
      }));
      let parsed: ReturnType<typeof parseSynthesisResult> = null;
      let failed = false;
      try {
        const raw = await codexRunText({
          prompt: buildSynthesisPrompt(fixture.query, shortlist),
          model: "gpt-5.6-luna",
          timeoutMs: 30_000,
          reasoningEffort,
        });
        parsed = parseSynthesisResult(raw, shortlist.length);
        failed = parsed === null;
      } catch {
        failed = true;
      }
      const rankedIds = parsed?.usedIndexes.map((index) => shortlist[index - 1]!.id) ?? [];
      const selectedIndex = rankedIds.indexOf(fixture.id);
      outcomes[queryIndex] = {
        id: fixture.id,
        correctRank: selectedIndex >= 0 ? selectedIndex + 1 : shortlist.length + 1,
        selected: rankedIds.length,
        candidatePresent: shortlist.some((candidate) => candidate.id === fixture.id),
        failed,
      };
      completed += 1;
      console.error(JSON.stringify({
        event: "rerank-progress",
        completed,
        total: fixtures.length,
      }));
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  return {
    system: `codex-luna-${reasoningEffort}-rerank:vector-single:multi_question_plus_lesson`,
    candidateRecallAt20:
      outcomes.filter((outcome) => outcome.candidatePresent).length / outcomes.length,
    recallAt1: outcomes.filter((outcome) => outcome.correctRank === 1).length / outcomes.length,
    recallAt5: outcomes.filter((outcome) => outcome.correctRank <= 5).length / outcomes.length,
    meanReciprocalRank:
      outcomes.reduce((sum, outcome) => sum + 1 / outcome.correctRank, 0) / outcomes.length,
    rejectedAll: outcomes.filter((outcome) => outcome.selected === 0).length,
    failures: outcomes.filter((outcome) => outcome.failed).length,
    elapsedMs: performance.now() - rerankerStartedAt,
    ...(process.env.BENCHMARK_VERBOSE === "1" ? { outcomes } : {}),
  };
}
