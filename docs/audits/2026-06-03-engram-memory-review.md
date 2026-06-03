# Engram Memory Review for Junior

Date: 2026-06-03
Reviewed repo: `https://github.com/anmolmoses/engram-memory`
Local clone: `/tmp/engram-memory-review`
Reviewed commit: `f5b05a1 fix(dashboard): scale the force layout for large graphs`

## Executive Summary

Do not replace Junior's memory system with Engram wholesale.

Engram is a good standalone recall library. It has a clean API, passing tests, hybrid lexical/vector recall, graph spreading activation, promotion/consolidation, recall evaluation, and a useful dashboard. But it is built as a rebuildable index over markdown/text memories. Junior's memory is an operational memory substrate: Slack source records, runner events, routing corrections, provenance, supersession, rule proposals, MCP tools, workflows, and routing-specific learned facts.

The right move is to mine Engram for retrieval mechanics and adapt them inside Junior's existing memory model.

Recommended direction:

1. Keep Junior's `memory_source_record`, `memory_node`, `memory_event`, `lesson`, `memory_fact`, provenance, correction, rule, and workflow surfaces authoritative.
2. Add Engram-inspired derived retrieval layers beside them: stopword-aware FTS query building, optional embeddings, RRF fusion, spreading activation, entity seeding, and recall evaluation.
3. Do not import Engram directly until there is a Bun-compatible store/runtime story and until its source/provenance model can represent Junior's operational correctness needs.

## What Engram Does Well

Engram is strongest as a compact retrieval engine.

Core capabilities found in the code:

- `Engram` public API with `add`, `addMany`, `indexDirectory`, `recall`, `recallTrace`, `dream`, `promote`, `consolidate`, `buildEdges`, `buildLlmEdges`, `graphExport`, `toContextBlock`.
- SQLite store with one `memory` table, FTS5 mirror, embedding blobs, edge table, and entity inverted index.
- Hybrid recall using vector cosine plus FTS5/bm25 fused with Reciprocal Rank Fusion (RRF).
- Stopword-aware shared tokenizer for both feature-hashing embeddings and FTS queries.
- Deterministic offline feature-hashing embedding provider, plus OpenAI embedding provider.
- Associative graph with `similar`, `temporal_next`, `about`, and optional LLM-derived `caused`, `supersedes`, `lesson_from` edges.
- Spreading activation with provenance for why a memory surfaced.
- Promotion/consolidation: frequently used episodic memories can become protected semantic/procedural memories; low-salience hot memories can be archived.
- Recall eval and weight tuning over labelled query sets.
- Built-in graph/dashboard endpoint for visualization.

Its test suite is real enough to trust basic behavior. After `npm install`, `npm test` passed:

```text
tests: 77
pass: 77
fail: 0
```

## Why It Should Not Replace Junior's Memory

### 1. Different Source-Of-Truth Model

Engram's model is:

```text
markdown/text files or add() content
  -> SQLite memory index
  -> recall
```

Junior's model is:

```text
Slack messages, routing decisions, runner outputs, manual corrections
  -> source records
  -> derived events/facts/lessons/summaries
  -> provenance, correction logs, rules, supersession, active/inactive filtering
  -> MCP/CLI/workflow recall and consolidation
```

Engram stores `source` as a file-ish string plus metadata. Junior stores source records as first-class data with actor, channel, thread, Slack timestamp, source URL, runner metadata, agent name, and source kind. That distinction matters because Junior memory is not just "what text did we remember?" It is "who said this, where, when, under what correction history, and is it still current?"

### 2. Junior Already Has Operational Memory Surfaces

Junior already has:

- `MemoryStore` contract with source records, events, lessons, facts, edges, corrections, candidate rules, recall, consolidation, archive, merge, update, and rebuild.
- SQLite schema with `memory_source_record`, `memory_node`, `memory_event`, `lesson`, `memory_fact`, `entity`, `tag`, `edge`, `memory_search_doc`, `memory_fts`, `memory_provenance`, `ingestion_classification`, `ingestion_correction`, `consolidation_decision`, and `candidate_rule`.
- `MemoryIngestor` capture for Slack messages, routing decisions, runner results, and runner tool errors.
- CLI: recall, consolidate, rule accept/reject/list, add/update/merge/archive memories, log corrections, rebuild FTS.
- MCP tools: `memory_recall`, `memory_consolidate`, `memory_set_rule_status`.
- Workflow integration for memory consolidation.

Replacing this with Engram would be a loss of semantics, not a simplification.

### 3. Runtime/Dependency Mismatch

Junior is Bun-first and uses `bun:sqlite`.

Engram is Node/npm-first and depends on `better-sqlite3`, a native dependency. Direct import would add:

- Node-native module dependency inside a Bun app.
- A second SQLite access style.
- Different sync behavior and migration assumptions.
- More friction for Junior's current deployment shape.

This is not disqualifying forever, but it is enough to avoid a drop-in replacement.

### 4. Engram's Default Semantic Layer Is Not Truly Semantic

Engram's default embedding provider is feature hashing. That is useful, deterministic, and offline, but it is lexical-ish. It does not know that "car" and "automobile" are related unless token overlap or graph edges bridge the gap.

Engram is honest about this in its docs and code. True semantic recall requires OpenAI embeddings or another real embedding provider.

For Junior, that means "use Engram and get semantic memory" is only true if we also adopt a real embedding model and manage the derived cache lifecycle.

### 5. Engram Lacks Junior's Validity And Correction Semantics

Engram has `archived` and edge type `supersedes`, but no first-class equivalent of Junior's correction lifecycle:

- no source-record table with typed operational origin;
- no ingestion correction table;
- no candidate rule lifecycle;
- no accepted/rejected rule workflow;
- no explicit valid/invalid timestamps on nodes;
- no active filtering by event/fact/lesson kind in the same shape;
- no provenance table tying derived memories to raw operational evidence.

This is the core reason to mine, not replace.

## Efficiency Audit

Someone saying "Engram is inefficient" is partly right, but the full answer is scale-dependent.

Engram is intentionally simple and brute-force in some core paths. That is fine at small memory sizes, risky for a long-running agent if copied unchanged, and not fine for unbounded Junior Slack memory without additional indexing and background-job controls.

### Hot Paths

#### Recall: Linear Vector Scan

Hybrid recall does:

1. embed the query;
2. call `store.allVectors()`;
3. decode every embedding BLOB into a `Float32Array`;
4. compute cosine against every vector;
5. sort all vector scores;
6. run FTS5;
7. fuse the candidate sets with RRF.

Complexity:

```text
semantic recall: O(N * dim) cosine + O(N log N) sort
lexical recall: indexed FTS5
fusion: bounded by candidate pool
```

The candidate pool bounds fusion, but not the vector scan or sort. For 256-dim feature-hashing vectors this is okay for thousands to low tens of thousands. For 1536-dim OpenAI embeddings, it gets more expensive.

The easy improvement is to avoid full sorting by maintaining a top-k heap over vector scores. The better scale-out improvement is a SQLite vector extension or ANN index (`sqlite-vec`, `sqlite-vss`, pgvector, etc.).

#### Graph Build: O(N^2) Similarity Edges

`buildEdges()` creates `similar` edges by pairwise cosine over all stored embeddings.

Complexity:

```text
similar edge build: O(N^2 * dim)
```

This is the biggest real inefficiency. It is acceptable for a demo or small note corpus. It is not acceptable as an automatic synchronous operation after every large reindex or on a growing Slack memory database.

Engram does this by default during `indexDirectory()` unless `edges: false` is passed.

For Junior, do not copy this behavior. Build similarity edges in a background job, incrementally, or via ANN.

#### AddMany/Indexing

`addMany()` embeds all inputs, then upserts every record and syncs FTS. That is reasonable. The measured `addMany()` curve below still grew nonlinearly in the synthetic benchmark because every record writes JSON/FTS/embedding blobs and because the generated dataset was large enough to show SQLite transaction and memory pressure.

For Junior, ingestion should remain append-oriented and cheap. Heavy embedding/edge construction should happen asynchronously.

#### `allRecords()` For Maintenance

Promotion, consolidation, graph export, and dashboard paths scan all records. This is fine as scheduled maintenance, but should not run on every turn or Slack message.

Junior should keep deterministic consolidation as a workflow/cron, not a hot-path request.

#### LLM Rerank And LLM Edges

Engram's LLM rerank and LLM edge builder are capped and failure-safe, but they are latency/cost-heavy by nature. They should be opt-in, not default on every Junior turn.

### Local Benchmark

Environment:

- Node `v22.22.3`
- Engram commit `f5b05a1`
- default hashing embedder (`256` dims)
- SQLite `:memory:`
- synthetic memory strings
- no real OpenAI embeddings
- recall query: `dashboard deploy migration tests gx-admin-client`
- recall repeated 8 times, median reported

Results:

| Memories | `addMany` | Recall median | Recall max | Similar edge build | Edges | RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 84 ms | 2.8 ms | 4.4 ms | 310 ms | 3,000 | 93 MB |
| 2,000 | not separately measured | not separately measured | not separately measured | 1,262 ms | 6,000 | 117 MB |
| 5,000 | 963 ms | 8.5 ms | 24.8 ms | 7,725 ms | 15,000 | 163 MB |
| 10,000 | 3,413 ms | 21.3 ms | 86.7 ms | not run | 0 | 232 MB |
| 20,000 | 13,126 ms | 40.4 ms | 87.0 ms | not run | 0 | 291 MB |

Interpretation:

- Plain recall is acceptable at 1k-20k memories with 256-dim hashing vectors.
- Recall cost is linear and visible. It is not catastrophic yet, but it will keep rising.
- Similar edge build grows quadratically. The 5k run took 7.7 seconds; extrapolating blindly is dangerous, but the shape is clear.
- With real 1536-dim embeddings, vector scan CPU and BLOB decode memory pressure would be substantially higher.
- The dashboard/graph export paths should be treated as local debugging tools, not hot-path product APIs.

Verdict on "inefficient":

- Fair criticism if the claim is about large-scale vector search and graph construction.
- Unfair if the claim is that Engram is unusably slow at small agent-memory scale.
- For Junior, the inefficient parts should be mined carefully and moved into derived/background retrieval jobs, not imported as hot-path defaults.

## Junior Search Performance Baseline

Junior's current search path is cheaper than Engram's default hybrid path because it does not scan vectors and it does not build O(N^2) similarity edges.

Current Junior recall does:

1. FTS5 lookup over `memory_fts`, bounded to `limit * 4`;
2. optional tag/entity exact lookup;
3. optional recursive edge traversal from seed ids, bounded to depth 0-3 and `limit * 6` returned edge rows;
4. in-memory candidate scoring/sorting;
5. `use_count`/`last_used_at` writeback for returned ids.

The good news:

- FTS recall is indexed and bounded.
- Candidate sets are usually small for normal query-driven recall.
- There is no vector scan, no embedding decode, and no pairwise similarity work on the hot path.
- Edge traversal is bounded by depth and result limit.

The risk:

- `tagEntityRows()` is unbounded before scoring. A broad tag can materialize thousands of candidates.
- When broad tag/entity recall is combined with `depth > 0`, all those ids become edge seeds. That can make recursive edge traversal much slower.
- The current FTS query builder is strict and quality-limited, but performance-wise that strictness often keeps result sets small.
- Recall updates returned rows every time. That is fine for small `limit`, but it is still write traffic on a read-like operation.

### Junior Synthetic Benchmark

Environment:

- Bun `1.2.17`
- SQLite via `bun:sqlite`
- Synthetic source records and events
- Query: `dashboard deploy migration tests`
- Recall repeated multiple times, median reported
- No embeddings

Normal FTS/tag/entity recall:

| Memories | Edges | Seed time | FTS median | FTS max | Tag/entity median | RSS |
| ---: | :---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | no | 250 ms | 0.8 ms | 1.6 ms | 0.6 ms | 51 MB |
| 5,000 | no | 2,428 ms | 6.1 ms | 7.3 ms | 4.2 ms | 59 MB |
| 10,000 | no | 7,404 ms | 11.6 ms | 15.4 ms | 4.5 ms | 96 MB |
| 1,000 | yes | 325 ms | 2.7 ms | 3.2 ms | 3.0 ms | 95 MB |
| 5,000 | yes | 2,447 ms | 11.8 ms | 12.9 ms | 14.8 ms | 100 MB |
| 10,000 | yes | 7,357 ms | 24.9 ms | 27.1 ms | 29.4 ms | 104 MB |

Broad-tag stress test, where every memory has the same tag:

| Memories | Tag recall depth 0 | Tag recall depth 2 | RSS |
| ---: | ---: | ---: | ---: |
| 1,000 | 2.2 ms | 11.4 ms | 71 MB |
| 5,000 | 12.2 ms | 59.0 ms | 109 MB |
| 10,000 | 28.8 ms | 110.3 ms | 145 MB |

Interpretation:

- Junior's normal search performance is good at 10k memory rows.
- Edge traversal adds visible cost but remains acceptable for narrow FTS-seeded recall.
- Broad tag/entity recall is the current performance weak spot.
- The first performance fix should be bounding/ranking tag/entity seeds before edge traversal, not adding a new search engine.
- Compared with Engram, Junior has lower hot-path algorithmic risk today. Engram has better retrieval quality mechanics, but Junior's current performance profile is safer because it avoids vector and O(N^2) work.

## What To Mine Into Junior

### 1. Stopword-Aware FTS Query Builder

Junior's current FTS query builder quotes all terms and joins them with spaces. That tends toward strict matching and includes low-value words.

Engram's better idea:

- share tokenization between lexical and embedding channels;
- drop stopwords;
- quote terms to neutralize FTS operators;
- join meaningful terms with `OR`.

Junior adaptation:

- Add `meaningfulTokens()` in `src/memory/search.ts` or similar.
- Replace `toFtsQuery()` in `src/memory/sqlite.ts`.
- Add tests for stopwords, punctuation, quotes, empty query, and rare identifiers.

Expected benefit:

- Better recall on natural Slack queries.
- Less dependence on exact wording.
- Fewer misses caused by filler terms.

### 2. RRF Fusion

Junior currently builds one candidate map and adds activation/kind/importance/frequency/recency. It works, but it is easy for boosts to dominate relevance.

Engram's better idea:

- treat FTS, vector, tag/entity, and graph activation as independent ranked channels;
- fuse by rank using RRF;
- apply importance/recency as gentle multipliers, not large additive boosts.

Junior adaptation:

```text
channels:
  lexical FTS
  tag/entity exact lookup
  graph activation
  optional embedding cosine

fusion:
  score += channelWeight / (rrfK + rank)
  score *= gentle kind/importance/recency factors
```

Expected benefit:

- Explainable recall scoring.
- Better resistance to stale/high-importance memories winning unrelated queries.
- Easier tuning via eval sets.

### 3. Optional Embedding Cache

Do not make embeddings authoritative. Add them as a rebuildable cache beside `memory_search_doc`.

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
```

Rules:

- `memory_search_doc` remains the text source for derived recall.
- Raw source records remain authoritative.
- If `body/title/outcome` changes, invalidate/rebuild embeddings by content hash.
- Do not block Slack ingestion on embedding generation.
- Start with local deterministic hashing or no embeddings; add OpenAI/local embeddings behind a provider interface.

### 4. Spreading Activation With Better Trace

Junior already has bounded recursive CTE traversal. Engram's spreading activation is cleaner as a retrieval signal:

- seed activation from lexical/tag/entity/vector hits;
- flow activation along weighted edges for a small number of hops;
- normalize across node fan-out;
- retain strongest provenance edge for the `why` trace.

Junior adaptation:

- Keep edge storage in SQLite.
- Pull seed and edge frontier into TypeScript for scoring, or implement equivalent recursive CTE plus trace.
- Return reason strings like `activation 0.123 via lesson_from<-event_...`.

Expected benefit:

- Better associative recall without needing a graph database.
- More debuggable memory results.

### 5. Entity Glossary And `about` Edges

Engram's offline entity extractor is pragmatic:

- code identifiers;
- backtick code spans;
- acronyms;
- proper-noun phrases;
- stopword filtering.

Junior already stores mentions/entities. It can enrich source/event text with a similar deterministic extractor, then build low-risk `about` edges.

Important constraint:

- Treat entity extraction as derived and rebuildable.
- Keep corrected/user-curated entities higher trust than heuristic entities.

### 6. Recall Evaluation

This is one of the most valuable pieces to port.

Add a labelled eval format:

```json
[
  {
    "query": "dashboard means admin client",
    "relevantIds": ["routing_memory_dashboard_means_gx-admin-client"]
  }
]
```

Metrics:

- recall@k;
- MRR;
- hit@1;
- per-query first relevant rank;
- optional "bad recalled ids" annotations.

Use this before changing weights. Build the first eval set from:

- prior routing corrections;
- known user feedback memories;
- stale-memory failures;
- agent dispatch mistakes;
- workflow/consolidation examples.

### 7. Graph/Recall Dashboard Ideas

Engram's dashboard is useful for human debugging, but Junior should not copy its full page as-is.

Better Junior approach:

- Add `/api/memory/graph` and `/api/memory/trace?query=...`.
- Reuse Junior's existing dashboard shell.
- Show nodes with kind, active/invalid state, source count, use count, provenance, and reasons.
- Keep it localhost-only unless a real auth/security pass happens.

## What Not To Copy

Do not copy these behaviors directly:

1. Do not run O(N^2) `similar` edge construction synchronously after every index.
2. Do not make markdown files the only source of truth.
3. Do not treat `source` string metadata as enough provenance.
4. Do not add `better-sqlite3` to Junior just to import Engram.
5. Do not run LLM rerank by default on every Slack message.
6. Do not let high importance override low relevance.
7. Do not auto-promote memories based only on use count without checking whether recall was actually useful.
8. Do not expose graph/dashboard memory views beyond localhost without auth.

## How To Make Engram Itself Better

If contributing upstream or using it in another agent, the highest-value improvements are:

1. Add first-class source records and provenance links.
2. Add validity timestamps and current-vs-historical recall semantics.
3. Add correction logs and accepted/rejected learned-rule workflow.
4. Add a Bun-compatible store or async store interface.
5. Replace full vector sort with top-k heap as the first easy optimization.
6. Add optional `sqlite-vec`/ANN backend for vector search.
7. Make graph building incremental.
8. Split synchronous "index" from background "derive embeddings/edges".
9. Add source-level privacy/security controls and redaction hooks.
10. Add migration versioning.
11. Update stale docs: the roadmap still says no consolidation/forgetting even though promotion/consolidation are implemented.
12. Add operational evals from real agent workloads, not only toy/sample notes.

## Proposed Junior Implementation Plan

### Phase 1: Low-Risk Recall Quality

Scope:

- Port stopword-aware tokenizer and FTS query builder.
- Add RRF scoring over existing FTS/tag/entity/edge channels.
- Keep schema unchanged.
- Add recall eval harness and a seed eval file.

Acceptance:

- Existing memory tests pass.
- New tests prove stopword-heavy Slack queries still find targeted memories.
- Eval output can be run from CLI/workflow.

### Phase 2: Optional Embedding Cache

Scope:

- Add `memory_embedding` table.
- Add embedding provider interface.
- Start with deterministic hashing provider for tests.
- Add rebuild command and background-safe API.
- Add vector recall as an optional RRF channel.

Acceptance:

- Embeddings are rebuildable from `memory_search_doc`.
- Recall works with embeddings disabled.
- No Slack ingestion path waits on embedding generation.

### Phase 3: Spreading Activation And Entity Enrichment

Scope:

- Port/adapt spreading activation.
- Add heuristic entity extraction for code identifiers, acronyms, and proper nouns.
- Build `about` edges as derived data.
- Add trace output to MCP/HTTP recall.

Acceptance:

- Recall can surface an activation-only memory with an explicit edge reason.
- Derived entity/edge rebuild is idempotent.
- Existing curated/corrected entities take precedence.

### Phase 4: Maintenance And Dashboard

Scope:

- Add graph export endpoint.
- Add trace endpoint.
- Improve consolidation with eval-backed promotion/archival rules.
- Add optional LLM rerank for manual/debug use, not default hot path.

Acceptance:

- Dashboard helps inspect why a memory surfaced.
- Consolidation decisions include source/provenance references.
- LLM features fail closed and do not block normal operation.

## Final Recommendation

Use Engram as prior art, not as Junior's replacement memory.

Junior's memory model is already closer to the correct product shape for an operational Slack coding-agent control plane. Engram is ahead in retrieval engineering and visualization. The winning design is:

```text
Junior authoritative memory DB
  raw source records
  typed events/facts/lessons/summaries
  provenance/corrections/rules/validity

+ Engram-inspired derived retrieval
  stopword-aware FTS
  optional embeddings
  RRF fusion
  spreading activation
  entity seeding/about edges
  recall eval
  graph/trace dashboard
```

This gets the useful parts of Engram without giving up Junior's correctness guarantees.
