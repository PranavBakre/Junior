// Synthetic memory corpus + labelled query fixtures for recall evaluation.
//
// The corpus is hand-authored so that each query category isolates one failure
// mode of the retrieval pipeline. Crucially the current FTS matches *all* query
// terms with no stemming, so:
//   - "lexical" queries use words that appear verbatim in the target body and
//     should always hit (sanity / precision baseline);
//   - "paraphrase" queries use deliberately disjoint vocabulary and stand in for
//     the LLM-paraphrased known-item queries a production eval would generate.
//     They are the population that motivates semantic (vector) recall.
//
// Keeping the corpus deterministic (no LLM, no Math.random, caller-supplied
// `now`) means the baseline numbers are reproducible and can act as regression
// floors.

import type { MemoryStore } from "../store.ts";

export type EvalCategory =
  | "lexical"
  | "paraphrase"
  | "tag"
  | "entity"
  | "edge"
  | "stale"
  | "archived"
  | "precision"
  | "correction";

export interface EvalCase {
  id: string;
  category: EvalCategory;
  query?: string;
  tags?: string[];
  entities?: string[];
  depth?: number;
  /** Ids that should surface for this query. Empty for invariant-only cases. */
  relevantIds: string[];
  /** Ids that must NOT outrank the relevant ids (or appear at all, if no relevant). */
  forbiddenIds?: string[];
  note: string;
}

export interface CorpusStats {
  memories: number;
  edges: number;
  stressTag: string;
  stressTagged: number;
}

const DAY = 24 * 60 * 60 * 1000;
export const STRESS_TAG = "common";

type SeedCtx = { store: MemoryStore; now: number; memories: number; edges: number };

async function addFact(
  ctx: SeedCtx,
  args: {
    id: string;
    kind: "curated_fact" | "routing_memory" | "procedure";
    body: string;
    title?: string;
    tags?: string[];
    entities?: Array<{ name: string; kind: string }>;
    importance?: number;
    confidence?: number;
    ageDays?: number;
  },
): Promise<void> {
  const createdAt = ctx.now - (args.ageDays ?? 0) * DAY;
  await ctx.store.appendSourceRecord({ id: `src_${args.id}`, kind: "curated_fact", body: args.body, createdAt });
  await ctx.store.upsertFact({
    id: args.id,
    kind: args.kind,
    title: args.title ?? null,
    body: args.body,
    importance: args.importance,
    confidence: args.confidence,
    createdAt,
    sourceIds: [`src_${args.id}`],
    tags: args.tags,
    entities: args.entities,
  });
  ctx.memories++;
}

async function addLesson(
  ctx: SeedCtx,
  args: { id: string; title: string; body: string; tags?: string[]; entities?: Array<{ name: string; kind: string }>; importance?: number; ageDays?: number },
): Promise<void> {
  const createdAt = ctx.now - (args.ageDays ?? 0) * DAY;
  await ctx.store.appendSourceRecord({ id: `src_${args.id}`, kind: "slack_message", body: args.body, createdAt });
  await ctx.store.upsertLesson({
    id: args.id,
    title: args.title,
    body: args.body,
    importance: args.importance,
    createdAt,
    sourceIds: [`src_${args.id}`],
    tags: args.tags,
    entities: args.entities,
  });
  ctx.memories++;
}

async function addEvent(
  ctx: SeedCtx,
  args: { id: string; body: string; threadId?: string; tags?: string[]; entities?: Array<{ name: string; kind: string }>; importance?: number; ageDays?: number },
): Promise<void> {
  const createdAt = ctx.now - (args.ageDays ?? 0) * DAY;
  await ctx.store.appendSourceRecord({ id: `src_${args.id}`, kind: "slack_message", body: args.body, createdAt });
  await ctx.store.upsertEvent({
    id: args.id,
    sourceRecordId: `src_${args.id}`,
    threadId: args.threadId ?? "T-eval",
    body: args.body,
    importance: args.importance,
    createdAt,
    tags: args.tags,
    entities: args.entities,
  });
  ctx.memories++;
}

async function link(ctx: SeedCtx, srcId: string, dstId: string, type: string, weight: number): Promise<void> {
  await ctx.store.addEdge({ srcId, dstId, type, weight, directed: true, createdAt: ctx.now });
  ctx.edges++;
}

/**
 * Seeds the full synthetic corpus into a store and returns the labelled cases
 * plus corpus statistics for the report header.
 */
export async function seedEvalCorpus(store: MemoryStore, now: number): Promise<{ cases: EvalCase[]; stats: CorpusStats }> {
  const ctx: SeedCtx = { store, now, memories: 0, edges: 0 };

  // --- lexical: verbatim content words, should always hit ----------------------
  await addFact(ctx, { id: "lex-worktree", kind: "curated_fact", body: "Worktrees are created only in target repos, never in the junior workspace." });
  await addLesson(ctx, { id: "lex-cleanup", title: "Cleanup safety", body: "Cleanup refuses to delete worktrees that still have unpushed commits." });
  await addFact(ctx, { id: "lex-sqlite", kind: "curated_fact", body: "Sessions persist in a sqlite database via bun." });

  // --- paraphrase: disjoint vocabulary, stands in for LLM-paraphrased queries ---
  await addFact(ctx, { id: "par-merge", kind: "curated_fact", body: "Always use a three-way merge; never squash when integrating branches." });
  await addLesson(ctx, { id: "par-impersonate", title: "Member flows", body: "Reproducing member-only flows requires impersonation; never use an admin account directly." });
  await addLesson(ctx, { id: "par-screenshot", title: "Visual evidence", body: "Download and view bug images before attempting reproduction." });

  // --- tag: structured lookup, no query ----------------------------------------
  await addFact(ctx, { id: "tag-routing-1", kind: "routing_memory", body: "Dashboard refers to the gx-admin-client repository.", tags: ["routing"] });
  await addFact(ctx, { id: "tag-routing-2", kind: "routing_memory", body: "PR links should be routed to the review agent.", tags: ["routing"] });

  // --- entity: exact entity match ----------------------------------------------
  await addFact(ctx, { id: "ent-port", kind: "curated_fact", body: "The gx-admin-client app listens on port 3002.", entities: [{ name: "gx-admin-client", kind: "repo" }] });

  // --- edge: payoff memory only reachable via same_topic edge ------------------
  await addEvent(ctx, { id: "edge-a", body: "Investigated the POW data shape mismatch on the projects page.", threadId: "T-edge" });
  await addLesson(ctx, { id: "edge-b", title: "Work plan shapes", body: "Personal and section-based plans diverge structurally; broken linkage leaks one into the other." });
  await link(ctx, "edge-a", "edge-b", "same_topic", 0.9);

  // --- stale: current must beat superseded -------------------------------------
  await addFact(ctx, { id: "stale-old", kind: "curated_fact", body: "Local dev proxies gx-client through the SSL path at growthx club.", importance: 0.9, ageDays: 200 });
  await addFact(ctx, { id: "stale-new", kind: "curated_fact", body: "Local dev wires gx-client directly to localhost; the SSL proxy path is inactive.", importance: 0.6, ageDays: 2 });
  await link(ctx, "stale-new", "stale-old", "supersedes", 1.0);

  // --- archived: must never surface by default ---------------------------------
  await addFact(ctx, { id: "arch-old", kind: "curated_fact", body: "Old deprecated note about the legacy openclaw heartbeat poller." });
  await store.archiveMemory("arch-old");

  // --- precision: strict-AND keeps common-word filler from flooding ------------
  await addLesson(ctx, { id: "prec-target", title: "Migration order", body: "Run the migration before deploying to avoid an issue with backfill." });

  // --- correction: tag channel compensates for missing lexical term ------------
  await addFact(ctx, { id: "corr-routing", kind: "routing_memory", body: "When a user says dashboard, route to gx-admin-client and not gx-client.", tags: ["routing"], entities: [{ name: "dashboard", kind: "alias" }] });

  // --- precision filler: contain "issue" but not the full query ----------------
  for (let i = 0; i < 20; i++) {
    await addEvent(ctx, { id: `prec-filler-${i}`, body: `Reported an issue with the build pipeline run number ${i}.`, threadId: "T-prec", tags: [STRESS_TAG] });
  }

  // --- broad-tag stress: many rows on one tag, with a traversal chain ----------
  const STRESS_N = 300;
  for (let i = 0; i < STRESS_N; i++) {
    await addEvent(ctx, { id: `stress-${i}`, body: `Routine status update number ${i} about the build pipeline.`, threadId: "T-stress", tags: [STRESS_TAG] });
  }
  // Chain the first 40 stress rows so broad-tag recall has dense edge seeds.
  for (let i = 0; i < 40; i++) {
    await link(ctx, `stress-${i}`, `stress-${i + 1}`, "same_topic", 0.5);
  }

  const stressTagged = 20 + STRESS_N;

  const cases: EvalCase[] = [
    { id: "lexical-worktree", category: "lexical", query: "target repos junior workspace", relevantIds: ["lex-worktree"], note: "Verbatim content words must hit." },
    { id: "lexical-cleanup", category: "lexical", query: "cleanup unpushed commits", relevantIds: ["lex-cleanup"], note: "Verbatim content words must hit." },
    { id: "lexical-sqlite", category: "lexical", query: "sessions persist sqlite", relevantIds: ["lex-sqlite"], note: "Verbatim content words must hit." },

    { id: "paraphrase-merge", category: "paraphrase", query: "avoid combining commits into one when landing code", relevantIds: ["par-merge"], note: "Synonyms of squash/merge; current FTS cannot reach this." },
    { id: "paraphrase-impersonate", category: "paraphrase", query: "to check screens shown to ordinary people pretend you are one of them", relevantIds: ["par-impersonate"], note: "Synonyms of member/impersonation." },
    { id: "paraphrase-screenshot", category: "paraphrase", query: "always look at attached pictures of the defect first", relevantIds: ["par-screenshot"], note: "Synonyms of bug images/view." },

    { id: "tag-routing", category: "tag", tags: ["routing"], relevantIds: ["tag-routing-1", "tag-routing-2", "corr-routing"], note: "Tag channel returns all routing memories." },

    { id: "entity-gxadmin", category: "entity", entities: ["gx-admin-client"], relevantIds: ["ent-port"], note: "Exact entity match." },

    { id: "edge-pow", category: "edge", query: "POW data shape projects page", depth: 2, relevantIds: ["edge-b"], note: "Payoff memory only reachable via same_topic edge from the lexical hit." },

    { id: "stale-localdev", category: "stale", query: "local dev gx-client", relevantIds: ["stale-new"], forbiddenIds: ["stale-old"], note: "Current memory must rank above the superseded one." },

    { id: "archived-openclaw", category: "archived", query: "openclaw heartbeat poller", relevantIds: [], forbiddenIds: ["arch-old"], note: "Archived memory must never surface by default." },

    { id: "precision-migration", category: "precision", query: "migration deploying backfill", relevantIds: ["prec-target"], note: "Strict-AND keeps 'issue' filler from flooding the result." },

    { id: "correction-dashboard", category: "correction", query: "dashboard route repo", tags: ["routing"], relevantIds: ["corr-routing"], note: "Tag channel compensates for the missing lexical term 'repo'." },
  ];

  return { cases, stats: { memories: ctx.memories, edges: ctx.edges, stressTag: STRESS_TAG, stressTagged } };
}
