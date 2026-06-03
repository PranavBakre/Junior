# Memory System Overhaul

## Problem

Junior's memory is structurally right but retrieval needs to get smarter without getting slower. The current memory store already captures Slack and runner source records, derived events, facts, lessons, tags, entities, edges, corrections, rules, provenance, and consolidation decisions. That is the correct foundation. The weaker part is recall quality: FTS is too literal, scoring is additive, broad tag/entity recall can get expensive, and there is no optional semantic channel or recall eval harness.

**Who has this problem:** Junior, persistent agents using `memory_recall`, routing, memory consolidation, and operators trying to debug why a memory did or did not surface.
**What happens today:** Recall is source-backed and cheap for normal FTS queries, but it misses paraphrased memories and can over-rank memories because kind/importance boosts are mixed directly into candidate scoring.
**Painful part:** Better memory recall is needed for repeated user preferences, routing mistakes, operational lessons, and prior project context, but adding vector search or graph expansion naively can make the hot path slower.
**"Finally" moment:** Junior recalls a small, sourced, high-relevance set of memories with a clear trace, while p95 recall latency remains bounded and broad searches cannot explode.

## Decision

Keep Junior's memory database as the authoritative source of truth. Do not replace it with Engram. Mine Engram for retrieval mechanics:

- stopword-aware tokenization;
- hybrid candidate channels;
- Reciprocal Rank Fusion (RRF);
- optional embedding cache;
- bounded vector candidate retrieval;
- OpenAI API embedding provider for the first vector phase;
- spreading activation with trace;
- recall evaluation and tuning;
- graph/debug views.

Research basis:

- Engram repo reviewed: https://github.com/anmolmoses/engram-memory at `f5b05a1b4fbebf260a072227ca1e7ff0dcbad21a` on 2026-06-03.
- Local audit: [Engram Memory Review for Junior](../audits/2026-06-03-engram-memory-review.md).
- Engram currently ships a Node >= 20 / `better-sqlite3` package with a single-table memory index, SQLite FTS5, embedding BLOBs, hybrid RRF recall, optional associative spreading, entity/about edges, promotion/consolidation, recall eval, graph export, and optional LLM rerank through CLI providers.
- Engram's default embedding provider is deterministic feature hashing. That is useful for tests and offline smoke runs, but it is lexical-ish, not true semantic recall. Junior should use hashing only as a deterministic provider/fallback, then use OpenAI API embeddings for the first real semantic benchmark.
- OpenAI embedding details were checked against official docs on 2026-06-03: `text-embedding-3-small` defaults to 1536 dimensions, `text-embedding-3-large` defaults to 3072, `dimensions` is supported for `text-embedding-3` and later models, `input` accepts a string or array of strings, and `encoding_format` can be `float` or `base64`.

The retrieval pipeline should be:

```text
incoming query
  v
query normalization
  - meaningful tokens
  - aliases / repo names / agent names
  - optional query expansion
  v
cheap candidate channels
  - FTS top N
  - tag/entity top N, capped
  - high-trust routing/procedure facts, capped
  - optional vector top M from rebuildable embedding cache
  v
RRF fusion
  - lexical rank
  - tag/entity rank
  - vector rank
  - high-trust fact rank
  v
bounded edge expansion
  - only from top K fused seeds
  - depth/fanout capped
  - spreading activation score + provenance trace
  v
final scoring
  - RRF base
  - gentle kind/importance/recency/confidence multipliers
  - active/valid/current filtering already applied inside channels
  v
top results
  - sourced snippets
  - score components
  - reason trace
  - source/provenance ids
```

Important correction to the tempting design: vector should not run only on "the remaining" FTS results. If vector only reranks FTS hits, it cannot recover memories that FTS missed because the words differ. If vector scans every remaining row and sorts everything, it adds Engram's scaling risk. The right shape is a parallel bounded channel: vector returns `top M`, FTS returns `top N`, then RRF merges them.

Provider order should be:

1. `hashing` for deterministic tests and zero-dependency fallback only.
2. `openai` for the first real semantic recall implementation and quality benchmark.
3. `local` later, as described in [Memory Local Embeddings](memory-local-embeddings.md).

Start the semantic phase with OpenAI API embeddings because they are simpler to integrate and benchmark than a local model runtime. Local embeddings remain a follow-up design.

## Non-Goals

- Do not make embeddings authoritative.
- Do not introduce a vector database as the primary memory substrate.
- Do not run O(N^2) similarity-edge construction on the hot path or after every ingest.
- Do not replace Junior's provenance/correction/rule model with markdown-index memory.
- Do not call an LLM on every recall by default.
- Do not let broad tag/entity recall seed unbounded edge traversal.
- Do not expose memory graph/debug views beyond localhost without auth.

## Current Junior Baseline

Junior currently has the right source-backed model:

- `memory_source_record` stores raw source evidence.
- `memory_node` tracks node kind, validity, invalidation, and supersession.
- `memory_event`, `lesson`, and `memory_fact` store searchable derived memories.
- `memory_provenance` links derived memories back to source ids.
- `memory_tag`, `mention`, `entity`, and `tag` provide structured lookup.
- `edge` stores typed relationships.
- `ingestion_correction`, `candidate_rule`, and `consolidation_decision` support learning and review.
- MCP/CLI/workflow surfaces already exist.

Current recall roughly does:

```text
FTS rows for query, bounded to limit * 4
  +
tag/entity rows, currently unbounded by row count
  +
edge traversal from seed ids, bounded by depth and return limit
  v
additive score = activation + kind boost + importance + frequency + recency
```

Code-level observations from `src/memory/sqlite.ts`:

- `toFtsQuery()` currently splits whitespace, quotes each term, and joins terms with spaces, so low-value words remain in the MATCH expression.
- `tagEntityRows()` loops all requested tags/entities and appends every matching joined row; there is no per-key or global cap before scoring.
- edge traversal runs after FTS and tag/entity rows are combined, so broad tag/entity matches become edge seeds.
- `edgeRows()` caps only the final related rows with `LIMIT`; it does not cap per-source fanout before recursive expansion.
- active/invalid/kind filtering currently happens after candidate materialization, which means stale or wrong-kind rows can still consume work before being filtered.
- `recordRecallUsage()` always writes `use_count` / `last_used_at` for returned ids, so eval/debug recall currently mutates future ranking and consolidation signals.

Performance observations from synthetic local benchmarks:

- Normal FTS recall is cheap at 10k rows.
- FTS plus edge traversal is still acceptable when seeds are narrow.
- Broad tag/entity recall is the current performance weak spot, especially when combined with edge traversal.
- Junior's current hot path is cheaper than Engram's default hybrid path because Junior does not scan vectors.

## Engram Lessons To Keep

### Stopword-Aware Tokenization

Engram's shared tokenizer drops filler words before both FTS and feature-hashing embeddings. Junior should adopt the same principle. FTS should rank on content-bearing terms like repo names, file identifiers, task nouns, commands, and correction language, not words like "how", "what", "the", or "with".

Target behavior:

```text
query: "how do I fix the dashboard migration issue again"
tokens: dashboard, migration, issue
```

FTS query building should:

- normalize text;
- remove stopwords;
- preserve useful code identifiers and repo names;
- quote terms to avoid FTS operator injection;
- use `OR` only as a controlled broad-recall mode;
- rank exact phrase and all-term matches ahead of loose `OR` matches;
- require at least one high-signal token before broad recall runs;
- optionally support exact phrase/required-term modes later.

Do not blindly replace every FTS query with loose `OR`. Broad `OR` improves recall but can hurt precision and latency on common words. The planner should choose among:

```text
exact phrase / exact identifier match
all-term match for high-signal short queries
controlled OR expansion for natural-language queries
```

Eval must include precision-regression cases for common terms like `fix`, `issue`, `dashboard`, `agent`, and `memory`.

### RRF Fusion

Engram's RRF fusion is the right scoring base. It combines ranks from different channels without trying to normalize incompatible scores.

Junior channels:

- lexical FTS rank;
- tag/entity exact-match rank;
- high-trust routing/procedure fact rank;
- optional vector rank;
- optional activation rank from edge expansion.

RRF formula:

```text
score(memory) += channelWeight / (rrfK + rankInChannel)
```

Then apply gentle multipliers:

```text
score *= kindMultiplier
score *= importanceMultiplier
score *= confidenceMultiplier
score *= recencyMultiplier
```

The multipliers must stay gentle. A stale high-importance memory should not beat a clearly relevant current memory.

### Spreading Activation

Engram's graph spreading is useful, but only after candidate seeds are bounded. Junior should not expand from every tag/entity result. Edge traversal should happen after first-pass fusion:

```text
top K fused seeds
  v
edge expansion with depth <= 2 by default
  v
activation contribution
  v
trace: memory X surfaced via same_topic from memory Y
```

This is smarter than current edge traversal because it treats the graph as a relevance signal with provenance, not just a related-row fetch.

Important detail to keep from Engram: activation should be fanout-normalized. A seed's charge should be split across its outgoing edges in proportion to edge weight, with hop decay and a minimum activation cutoff. Otherwise tag/entity hubs and dense derived edges can flood unrelated memories.

Target activation shape:

```text
for each hop:
  for each source seed/frontier node:
    load top weighted outgoing memory-to-memory edges
    totalWeight = sum(edge.weight)
    flow = sourceActivation * decay * edge.weight / totalWeight
    drop flow below minActivation
    accumulate received activation and strongest provenance edge
```

Do not count a seed's own injected score as graph activation. Activation should mean "this node was reached through the graph", not "this node was already a lexical/vector hit".

### Evaluation

Engram's recall eval loop is mandatory for this overhaul. Junior should not tune recall by feel.

Metrics:

- recall@k;
- MRR;
- hit@1;
- p50/p95 latency;
- broad-query worst case;
- top bad results for review;
- "expected memory missed" report.

Eval recall must run with `recordUsage=false`, vector mode fixed, edge mode fixed, and candidate budgets printed. Otherwise the benchmark can mutate `use_count` or silently compare different pipelines.

## Proposed Architecture

### Authoritative Store

Keep the existing memory schema as the source of truth. Add derived caches beside it.

Authoritative:

```text
memory_source_record
memory_node
memory_event
lesson
memory_fact
memory_provenance
ingestion_correction
candidate_rule
consolidation_decision
```

Derived/rebuildable:

```text
memory_search_doc
memory_fts
memory_embedding
heuristic entity aliases
derived about/similarity edges
recall_eval_result
```

Not every tag/entity/edge is equally rebuildable. Curated, corrected, or accepted-rule tags/entities are authoritative derived memories with provenance and should not be deleted by a heuristic rebuild. Heuristic aliases, `about` edges, and similarity edges are projections and may be deleted/rebuilt.

Add explicit provenance/trust metadata to rebuildable projections where useful. For example, a heuristic `about` edge should be distinguishable from an operator-curated `same_topic` or `applies_to` edge so rebuild jobs can safely delete only their own projections.

### Embedding Cache

Embeddings are optional and rebuildable.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS memory_embedding (
  memory_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, model),
  FOREIGN KEY (memory_id) REFERENCES memory_search_doc(id)
);

CREATE INDEX IF NOT EXISTS memory_embedding_model_idx
  ON memory_embedding(model, dim);
```

Rules:

- The embedding text is derived from `memory_search_doc` fields.
- Store a content hash so changed docs invalidate old embeddings.
- Encode embeddings as little-endian `Float32Array` BLOBs.
- Validate BLOB byte length against `dim * 4` before scoring.
- Embeddings may be missing. Recall must still work.
- Stale embeddings with mismatched `content_hash`, `model`, or `dim` are excluded from vector recall.
- If a `memory_search_doc` is deleted, archived, invalidated, or superseded, vector recall must not return its stale embedding unless historical recall is explicitly requested.
- Embedding generation runs in a workflow/background pass, not Slack ingest.
- Default state can be off until measured semantic value justifies enabling vector recall.

### OpenAI API Embedding Provider

Use the OpenAI embeddings API for the first semantic recall implementation. Official OpenAI docs list `text-embedding-3-small` and `text-embedding-3-large` as the current third-generation embedding models, with default dimensions of 1536 and 3072 respectively, and support for a `dimensions` parameter on `text-embedding-3` models to reduce vector size. The embeddings API accepts a string or an array of strings as input, so rebuild jobs can batch rows. Sources:

- Embeddings guide: https://developers.openai.com/api/docs/guides/embeddings
- Embeddings API reference: https://developers.openai.com/api/reference/resources/embeddings/methods/create

Recommended first provider:

```text
provider: openai
model: text-embedding-3-small
dimensions: 512 initially, benchmark against 256 and 1536
encoding_format: float
```

Why `text-embedding-3-small` first:

- lower cost and smaller default vector than `text-embedding-3-large`;
- enough quality for a first recall eval;
- supports dimension reduction, which lets Junior trade accuracy for lower storage and faster local dot products;
- avoids local model packaging, runtime, and memory-pressure work during the first implementation.

Provider requirements:

```text
no embedding calls in Slack ingest
batch embedding in rebuild workflow
retry/backoff for API failures
rate-limit safe queueing
content_hash invalidation
model + dimensions recorded with every vector
normalize vectors before storing or scoring if the provider does not guarantee unit vectors
recall degrades to FTS/tag/entity/edge when vectors are unavailable
```

Suggested config:

```text
MEMORY_VECTOR_PROVIDER=openai
MEMORY_VECTOR_MODEL=text-embedding-3-small
MEMORY_VECTOR_DIMENSIONS=512
MEMORY_VECTOR_BATCH_SIZE=128
MEMORY_VECTOR_TIMEOUT_MS=30000
OPENAI_API_KEY=<provided by environment>
```

Do not hard-code the API key in Junior config files. Read it from the process environment.

Local embeddings are still desirable later for privacy/offline operation. Keep that design separate so the OpenAI-first implementation can land quickly.

### Vector Candidate Retrieval

V1 vector retrieval can be a linear scan if feature-flagged and capped. It should not be default for large stores without measured p95.

Better progression:

1. Implement provider interface and `memory_embedding` cache.
2. Add vector scan behind `MEMORY_VECTOR_RECALL_ENABLED=false` by default.
3. Return only `top M`, for example 40.
4. Track latency in recall output/logs.
5. Add top-k heap before enabling larger stores.
6. Move to `sqlite-vec` or another ANN path if vector recall becomes default.

Do not sort every vector if only top M is needed. Use a bounded top-k structure.

A top-k heap avoids sorting every vector, but it still computes similarity for every eligible embedding. For stores above a configured threshold, vector recall should be manual/debug-only unless an ANN path is enabled.

Suggested threshold:

```text
MEMORY_VECTOR_LINEAR_SCAN_MAX_ROWS=10000
```

Vector candidates must be filtered by model, dimension, active/current status, requested kind, and fresh content hash before they count against the candidate budget.

Vector implementation rules:

- Embed the query once per recall only if vector mode is enabled and eligible cached rows exist.
- Fetch only active/current candidate metadata plus fresh embedding BLOBs for the configured provider/model/dim.
- Decode BLOBs lazily enough to avoid materializing unrelated models or stale rows.
- Maintain a bounded top-k heap while scanning; never full-sort all vector scores in V1.
- If eligible row count exceeds `MEMORY_VECTOR_LINEAR_SCAN_MAX_ROWS` and no ANN path is configured, skip vector in `auto` mode and include a trace reason.
- In `force` mode, allow the scan but report row count and latency.

### Candidate Budget

Every channel gets a hard budget.

Initial defaults:

```text
FTS_CANDIDATES = 80
TAG_ENTITY_CANDIDATES = 40
ROUTING_FACT_CANDIDATES = 20
VECTOR_CANDIDATES = 40
FUSED_SEEDS_FOR_EDGES = 15
EDGE_DEPTH = 2
EDGE_FANOUT_PER_SEED = 20
FINAL_LIMIT = 5 or caller limit
```

These should be config values and included in eval output.

Budgets apply after default active/current/kind filters. Invalid, inactive, wrong-kind, or stale rows should not consume budget unless the caller explicitly asks for historical recall.

### Broad Tag/Entity Protection

Broad tag/entity recall needs a guard before edge traversal.

Current risk:

```text
tag: common
  -> thousands of rows
  -> thousands of edge seeds
  -> slow recursive traversal
```

Target behavior:

```text
tag/entity lookup
  -> rank by trust, kind, recency, importance, exactness
  -> cap to TAG_ENTITY_CANDIDATES
  -> only capped candidates enter RRF
  -> only top fused seeds enter edge expansion
```

Suggested ordering for tag/entity rows:

1. active/current rows first;
2. routing/procedure/fact/lesson before raw events;
3. exact entity match before tag match;
4. higher confidence/importance;
5. recent use or recent creation;
6. lower source ambiguity.

Algorithm:

```text
for each requested tag/entity:
  fetch filtered candidates with deterministic ORDER BY
  cap per requested key
merge candidate lists
dedupe by memory id
apply global TAG_ENTITY_CANDIDATES cap
```

Suggested SQL ordering:

```text
active DESC,
invalid_at IS NULL DESC,
kind_priority DESC,
exact_match DESC,
confidence DESC,
importance DESC,
last_used_at DESC NULLS LAST,
created_at DESC,
id ASC
```

Caps:

```text
TAG_ENTITY_CANDIDATES_PER_KEY = 20
TAG_ENTITY_CANDIDATES = 40
```

This prevents one broad tag from consuming the whole channel and gives stable benchmark behavior.

Entity aliasing and heuristic extraction should be separate from exact structured lookup. Exact tags/entities supplied by a user or stored by accepted rules are higher trust. Heuristic extracted aliases should use their own table or source marker and should be capped by document frequency, similar to Engram's `about` edge protection.

Suggested heuristic entity/about-edge controls:

```text
MEMORY_HEURISTIC_ENTITY_ENABLED=false initially
MEMORY_ABOUT_EDGE_MAX_DOC_FREQ=8
MEMORY_ABOUT_EDGE_MAX_EDGES_PER_MEMORY=20
```

Do not let `tag:*` or `entity:*` nodes act as graph traversal intermediates in normal recall. They are index hubs; candidate lookup can use them, but spreading activation should prefer memory-to-memory edges.

### Trust And High-Trust Facts

The `routingFactCandidates` channel must not exist until trust is defined. Routing memories can influence dispatch, so trust policy is part of correctness, not decoration.

Suggested trust inputs:

- source kind: manual correction, curated fact, accepted rule, routing correction, raw routing decision;
- actor kind: human, Junior, agent, bot, system;
- fact confidence;
- provenance count and diversity;
- accepted/rejected correction history;
- valid/invalid/superseded state;
- recency for aliases and preferences.

Suggested trust order:

```text
curated operator fact
accepted correction-derived fact
accepted learned rule output
repeated correction-derived routing memory
single routing decision
raw event
```

High-trust fact recall should require:

```text
active/current node
confidence >= configured threshold
trusted source class
non-empty provenance
no superseding current fact
```

Until this is implemented, routing/procedure facts should remain ordinary candidates, not a privileged channel.

First implementation should therefore skip `routingFactCandidates` as a separate privileged channel. Phase 1 and Phase 2 should make routing/procedure memories better through bounded FTS/tag/entity/RRF. Add the high-trust channel only after trust scoring has tests against corrections, accepted rules, supersession, and provenance diversity.

### Final Result Shape

Recall should return enough information to debug:

```ts
type MemoryRecallResult = {
  id: string;
  kind: "event" | "lesson" | "summary" | "fact" | "procedure" | "routing_memory";
  title: string | null;
  body: string;
  outcome: string | null;
  score: number;
  scoreParts: {
    rrf: number;
    lexical?: number;
    tagEntity?: number;
    vector?: number;
    activation?: number;
    kindMultiplier?: number;
    importanceMultiplier?: number;
    recencyMultiplier?: number;
    confidenceMultiplier?: number;
  };
  ranks: {
    lexical?: number;
    tagEntity?: number;
    vector?: number;
    activation?: number;
  };
  reasons: string[];
  sourceIds: string[];
  trace?: Array<{
    fromId: string;
    edgeType: string;
    activation: number;
    hop: number;
  }>;
};
```

The model-facing context can stay compact. The structured trace is for MCP/HTTP/debug/eval.

## Recall Flow

### Step 1: Query Planning

Input:

```ts
type MemoryRecallOptions = {
  query?: string;
  tags?: string[];
  entities?: string[];
  kinds?: SearchableMemoryKind[];
  limit?: number;
  /** Existing option. Keep during migration; map to edgeDepth internally. */
  depth?: number;
  includeInactive?: boolean;
  includeInvalid?: boolean;
  vector?: "off" | "auto" | "force";
  edgeExpansion?: "off" | "auto" | "force";
  explain?: boolean;
  /** Defaults to true for agent context, false for eval/debug. */
  recordUsage?: boolean;
  callerIntent?: "agent_context" | "eval" | "debug" | "workflow";
  /** Optional explicit benchmark/debug label to include in trace output. */
  traceLabel?: string;
};
```

Planning output:

```ts
type RecallPlan = {
  lexicalQuery?: string;
  normalizedTags: string[];
  normalizedEntities: string[];
  useVector: boolean;
  useEdges: boolean;
  budgets: {
    lexical: number;
    tagEntity: number;
    vector: number;
    edgeSeeds: number;
    edgeDepth: number;
    edgeFanoutPerSeed: number;
  };
};
```

### Step 2: Candidate Channels

Run channels independently:

```text
lexicalCandidates = FTS(lexicalQuery, FTS_CANDIDATES)
tagEntityCandidates = tag/entity lookup capped to TAG_ENTITY_CANDIDATES
routingFactCandidates = high-trust facts/procedures only after trust policy lands
vectorCandidates = vector top M if enabled and embedding exists
```

Each channel returns ids and ranks.

Active/current/kind filters should be pushed into each channel before `LIMIT`, unless `includeInactive` or `includeInvalid` is explicitly set. Otherwise stale rows can consume candidate budget or become edge seeds before being filtered out.

Queries with no normalized lexical terms can still use explicit tags/entities, but should skip FTS. Queries with neither lexical terms nor structured filters should return no candidates rather than broad-scanning memory.

### Step 3: RRF Fusion

Fuse candidates by rank. Do not use raw FTS bm25 and raw cosine directly as final scores.

```text
baseScore = rrf(lexicalRank) + rrf(tagEntityRank) + rrf(vectorRank) + rrf(routingFactRank)
```

Filter inactive/invalid/currentness before final ranking, unless explicitly requested.

### Step 4: Edge Expansion

Take the top `FUSED_SEEDS_FOR_EDGES` from RRF, then expand.

Edge rules:

- default depth 2;
- cap fanout;
- expand only the top weighted edges per source per hop;
- avoid tag/entity hub nodes as traversal intermediates unless explicitly requested;
- normalize activation over source fanout;
- drop tiny activation flows;
- prefer stronger edge weights;
- do not traverse invalid/superseded nodes unless requested;
- apply active/current/kind filters during traversal, not only after traversal;
- treat `supersedes` specially so current memories beat old ones;
- preserve activation trace.

Activation results become another channel and can be RRF-fused or gently added as a bounded score part.

Implementation options:

```text
TypeScript frontier:
  for each hop:
    load top weighted edges for current frontier ids
    cap per source id
    filter active/current/kind
    split source activation across outgoing edge weights
    accumulate received activation and trace

SQL frontier:
  use a window function over edge rows:
    row_number() over (partition by src_id order by weight desc, created_at desc)
  keep only rows <= EDGE_FANOUT_PER_SEED before recursive expansion
```

The current implementation only limits the final ranked related rows. That is not enough for dense nodes.

### Step 5: Final Scoring And Context

Final sorting:

```text
final = RRF base + bounded activation
final *= gentle kind/importance/confidence/recency multipliers
```

Then dedupe by normalized body/title/kind and return `limit`.

The prompt context block should include:

- memory kind/title/body;
- why it surfaced;
- source count or source ids if useful;
- currentness warning if historical.

Usage writeback must be caller-controlled. Normal agent-context recall can update `use_count` and `last_used_at`; eval/debug/trace recall must default to no writeback so measurement does not mutate future ranking or consolidation.

## Ingestion And Maintenance

### Hot Path

Slack and runner ingestion must stay cheap:

```text
capture source record
upsert event/fact if deterministic
sync memory_search_doc + FTS
log classifications/corrections
return
```

Do not:

- call embedding API;
- build similarity graph;
- derive heuristic about edges;
- run LLM rerank;
- run consolidation.

### Background Jobs

Background/workflow work:

- rebuild FTS;
- rebuild embeddings;
- derive heuristic entities;
- build `about` edges;
- build optional similarity edges with ANN/top-k, not O(N^2);
- run consolidation/dreaming;
- run recall eval;
- produce dashboard graph exports.

Each background job must be idempotent and scoped to its own derived artifacts. For example, an embedding rebuild may upsert `memory_embedding` rows for a `(provider, model, dim)` without deleting other providers' rows; an about-edge rebuild may delete only heuristic `about` edges from its own derivation version.

### Similarity Edges

Do not copy Engram's O(N^2) `similar` edge builder as a default.

If similarity edges are needed:

- build incrementally for changed memories only;
- compare against ANN/top-k vector candidates;
- cap edges per memory;
- store as derived/rebuildable;
- run in workflow, never in recall or Slack ingest.

## Evaluation And Latency Gates

Every recall change must be measured on quality and speed.

### Eval Set

Create `data/evals/memory-recall.json` or a docs fixture with labelled examples:

```json
[
  {
    "query": "dashboard means admin client",
    "tags": ["routing"],
    "relevantIds": ["routing_memory_dashboard_means_gx-admin-client"],
    "notes": "Repo alias correction should surface."
  }
]
```

Seed examples from:

- routing corrections;
- user preference corrections;
- repo aliases;
- repeated bug-pipeline lessons;
- stale-memory failures;
- procedures agents often forget;
- prior review/reproducer/thinker dispatch lessons.

### Metrics

Report:

```text
recall@1
recall@5
MRR
hit@1
p50 latency
p95 latency
worst query latency
candidate counts by channel
candidate counts before/after filtering
usage-writeback mode
missed expected ids
top false-positive ids
```

### Gates

Suggested gates before enabling each phase by default:

- FTS/RRF phase: p95 no worse than current baseline by more than 20%.
- Broad tag/entity recall: p95 under 75 ms on 10k synthetic rows.
- Edge expansion: p95 under 100 ms on 10k synthetic rows with representative edges.
- Vector phase with hashing: p95 under 100 ms on 10k rows.
- Vector phase with OpenAI embeddings: p95 under agreed threshold before default; otherwise manual/opt-in only.
- Vector phase above `MEMORY_VECTOR_LINEAR_SCAN_MAX_ROWS`: requires top-k heap plus measured real-data p95, or ANN.

Synthetic benchmarks are not a substitute for real `MEMORY_DB_PATH` measurements, but they catch scaling shape before rollout.

Benchmark reports must include:

```text
machine / runtime
DB path and SQLite mode
row counts by memory kind
edge count and max/median degree
tag/entity cardinality
embedding provider/model/dim
candidate budgets
recordUsage setting
```

## Feature Flags And Config

Suggested env/config:

```text
MEMORY_RECALL_RRF_ENABLED=true
MEMORY_RECALL_EDGE_EXPANSION=auto
MEMORY_VECTOR_RECALL_ENABLED=false
MEMORY_VECTOR_PROVIDER=openai
MEMORY_VECTOR_MODEL=text-embedding-3-small
MEMORY_VECTOR_DIMENSIONS=512
MEMORY_VECTOR_LINEAR_SCAN_MAX_ROWS=10000
MEMORY_RECALL_FTS_CANDIDATES=80
MEMORY_RECALL_TAG_ENTITY_CANDIDATES=40
MEMORY_RECALL_TAG_ENTITY_CANDIDATES_PER_KEY=20
MEMORY_RECALL_VECTOR_CANDIDATES=40
MEMORY_RECALL_EDGE_SEEDS=15
MEMORY_RECALL_EDGE_DEPTH=2
MEMORY_RECALL_EDGE_FANOUT_PER_SEED=20
MEMORY_RECALL_TRACE_ENABLED=false
MEMORY_RECALL_RECORD_USAGE_DEFAULT=true
```

Default should be conservative:

1. RRF on only after tests/eval pass.
2. Vector off until OpenAI embedding cache and latency metrics exist.
3. Edge expansion auto only from fused seeds, not raw tag/entity lists.

Compatibility:

- Preserve existing `depth` recall option for MCP/HTTP/CLI callers during migration.
- Map `depth` to `edgeExpansion` and `edgeDepth` internally.
- Return existing compact result fields by default.
- Return `scoreParts`, `ranks`, and `trace` only when `explain=true` or a debug endpoint asks for them.
- Add config parsing and tests for every new `MEMORY_*` knob before using those knobs in code.

API namespace:

- Keep existing `/api/memory` docs-browser behavior unless intentionally migrated.
- Prefer `/api/associative-memory/recall`, `/api/associative-memory/trace`, and `/api/associative-memory/graph` for the new debug surfaces, or explicitly update the dashboard route contract.

## Implementation Plan

### Phase 0: Baseline And Safety

1. Add a benchmark command or test helper for memory recall.
2. Record current p50/p95 for FTS, tag/entity, and edge recall.
3. Add a small labelled recall eval fixture.
4. Add candidate-count and latency logging behind debug mode.
5. Add `recordUsage` / `callerIntent` support so eval/debug recalls do not mutate memory.
6. Add config parsing tests for planned recall budgets and feature flags.
7. Document the current Engram/Jr baseline in the benchmark output header, including Engram commit if used for comparison.

Exit criteria:

- We can compare recall quality and latency before/after changes.
- Broad tag/entity stress case is captured.

### Phase 1: Smarter FTS And Bounded Seeds

1. Add `meaningfulTokens()`.
2. Replace FTS query building with stopword-aware planned search modes.
3. Add configurable FTS candidate limit.
4. Cap tag/entity candidates before they become edge seeds.
5. Define per-key and global tag/entity cap SQL with deterministic ordering.
6. Keep scoring mostly unchanged until eval proves query behavior.
7. Push active/valid/kind filters into FTS and tag/entity SQL before `LIMIT`.

Exit criteria:

- Natural-language queries improve or hold in eval.
- Broad tag/entity + edges no longer scales with all matching rows.
- Common broad Slack phrases do not flood candidates.

### Phase 2: RRF Fusion

1. Introduce channel result types.
2. Make FTS and tag/entity independent channels.
3. Fuse by RRF.
4. Convert kind/importance/recency to gentle multipliers.
5. Return score parts and ranks in debug/MCP JSON.
6. Keep the high-trust routing/procedure channel disabled until Phase 2.5 trust work is complete.

Exit criteria:

- Eval quality improves or holds.
- p95 latency stays within gate.
- Reason traces explain all top results.

### Phase 2.5: Trust-Gated Routing/Procedure Channel

1. Define trust scoring for curated facts, correction-derived facts, accepted rules, routing memories, procedures, and raw events.
2. Add provenance-diversity checks and supersession/currentness checks.
3. Add tests for "wrong old routing memory must not outrank current correction".
4. Add `ROUTING_FACT_CANDIDATES` only after those tests pass.

Exit criteria:

- Privileged routing/procedure recall never returns invalid/superseded memories by default.
- Raw routing decisions are not promoted into the high-trust channel without accepted correction/rule evidence.
- Dispatch-sensitive callers can inspect trust reasons in debug output.

### Phase 3: Edge Activation

1. Expand edges only from top fused seeds.
2. Implement spreading activation with hop/fanout caps.
3. Add activation trace.
4. Treat invalid/superseded nodes correctly.
5. Skip tag/entity hub nodes as traversal intermediates in default recall.
6. Add heuristic entity/about-edge rebuild only after exact tag/entity capping is stable.

Exit criteria:

- Activation-only relevant memories can surface.
- Broad tag/entity queries remain bounded.
- Trace explains edge-derived results.

### Phase 4: Embedding Cache And Vector Channel

1. Add `memory_embedding` table.
2. Add embedding provider interface.
3. Add hashing provider for deterministic tests.
4. Add OpenAI embedding provider using `text-embedding-3-small`.
5. Add rebuild command/workflow with batching and retry/backoff.
6. Add vector top-M candidate channel behind flag.
7. Use top-k heap or ANN path before enabling for large stores.
8. RRF-fuse vector ranks with FTS/tag/entity.
9. Add `openai` provider benchmarks for 256, 512, and 1536 dimensions before choosing the default.

Exit criteria:

- Recall works with vector disabled, missing embeddings, or stale embeddings.
- Embeddings are rebuildable from authoritative search docs.
- OpenAI provider failure degrades to non-vector recall.
- Vector channel improves eval enough to justify latency.

### Phase 5: Dashboard And Operations

1. Add `/api/associative-memory/trace`.
2. Add `/api/associative-memory/graph` if needed.
3. Show candidate counts, score parts, edge traces, active/currentness, and source ids.
4. Add workflow output for eval and consolidation decisions.

Exit criteria:

- Operators can debug why a memory surfaced.
- Stale/invalid memories are visible as historical, not silently treated as current.

## Risks And Mitigations

### Risk: Vector Recall Makes Hot Path Slower

Mitigation:

- Feature flag off by default.
- Top-M only.
- Top-k heap or ANN before defaulting on.
- p95 latency gate.
- Derived cache, not synchronous embedding calls.

### Risk: RRF Improves Scores But Hurts Existing Good Queries

Mitigation:

- Add eval fixture before switching.
- Keep old scoring behind a flag for rollback.
- Compare per-query diffs.

### Risk: Broad Tags Still Explode

Mitigation:

- Hard cap tag/entity candidates.
- Do not use raw tag/entity rows as edge seeds.
- Track candidate counts in recall traces.

### Risk: Stale Memories Become More Convincing

Mitigation:

- Current/valid filtering stays before final return.
- `supersedes` and `invalid_at` remain authoritative.
- Historical recall requires explicit include flags.

### Risk: LLM Rerank Becomes A Hidden Dependency

Mitigation:

- Keep LLM rerank manual/debug/workflow-only initially.
- Never block ordinary recall on LLM.
- Fail closed to deterministic ranking.

## Open Questions

- What starting dimension should win the eval/latency tradeoff: 256, 512, or 1536?
- Should vector recall be available to agents by default once cache exists, or only for consolidation/debug workflows?
- Do we need separate budgets for routing recall vs general memory recall?
- Should usage writeback happen synchronously for `agent_context`, or be batched after recall?

## Final Shape

Junior's memory system should become:

```text
source-backed memory core
  - raw Slack/runner/operator evidence
  - typed events/facts/lessons/procedures
  - provenance/corrections/rules/validity

bounded hybrid retrieval
  - FTS first
  - tag/entity exact lookup, capped
  - optional vector top-M, cached
  - RRF fusion
  - edge activation only from top fused seeds

measured operations
  - recall eval
  - latency gates
  - trace/debug dashboard
  - background rebuilds for derived caches
```

This keeps Junior's current performance advantage while adding the retrieval quality pieces that make Engram attractive.
