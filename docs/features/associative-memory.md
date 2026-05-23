# Associative Memory MVP

## Problem

Junior needs useful long-term recall across Slack threads without stuffing every past note into prompt context. The current direction is an associative memory system, but the design should avoid unnecessary infrastructure: no vector database as the default substrate, no graph database until proven necessary, and no Prolog/runtime mismatch in a TypeScript codebase.

**Who has this problem:** Junior operators and agents trying to remember prior decisions, blockers, lessons, and repeated user/project patterns.
**What happens today:** Recall depends on manual context, grep-like lookup, or whatever is already in session context.
**Painful part:** Important lessons get buried; stale facts can be reused; broad memory systems add re-embedding, graph-store, or runtime complexity before proving value.
**"Finally" moment:** Junior asks a recall tool and gets a small, sourced set of relevant prior events/lessons with a clear explanation of why they surfaced.

## Opinionated Direction

Start with **SQLite + TypeScript**, not a vector DB, graph DB, or Prolog layer.

The useful core is:

1. raw event capture from Slack messages/replies;
2. extracted tags, entities, outcomes, importance, and relationships;
3. full-text search over event/lesson text;
4. recursive CTE traversal over an `edge` table for graph-like recall;
5. TypeScript scoring/rules;
6. a small/fast recall LLM that expands the query and selects final snippets.

This keeps memory explainable, rebuildable, cheap to operate, and idiomatic for Junior's JS/TS stack.

## Why Not a Vector DB First

Avoid making embeddings the foundation.

- Changed memory requires re-embedding changed rows.
- Embeddings become another stale derived cache to version and rebuild.
- Vector similarity is opaque compared with tags/entities/edges and source-backed snippets.
- Junior-scale memory likely fits lexical search + structured metadata for a long time.

Embeddings can be added later as an optional acceleration layer if recall misses too much. If added, they should be derived/rebuildable, not authoritative.

## Why Not a Graph DB First

The useful part is relationships, not graph infrastructure.

Model relationships in SQLite:

- `event -> lesson` via `lesson_from`
- `fact -> fact` via `supersedes`
- `event -> event` via `same_topic`, `follows_up`, `contradicts`
- `event -> entity` via `mentions`
- `lesson -> topic` via `applies_to`

SQLite recursive CTEs provide enough graph traversal for early scale. A graph DB is only worth revisiting if traversal becomes the primary workload and SQLite edge expansion becomes a measured bottleneck.

## Why Not Prolog First

Prolog fits symbolic reasoning, but Junior is a TypeScript codebase. Adding a new logic runtime increases maintenance cost and conceptual overhead.

Prefer:

- SQLite recursive CTEs for relationship traversal;
- pure TypeScript rules for promotion, ranking, filtering, and policy;
- tests around those rules.

This gives most of Prolog's practical value — facts, relationships, explainable rules — without introducing a niche runtime.

## Prior Art and Tradeoffs

These systems are useful references, but none should be copied wholesale for Junior v1.

### SQLite FTS5

[SQLite FTS5](https://www.sqlite.org/fts5.html) is the local full-text search substrate recommended for v1. FTS means **full-text search**: an index over text documents that can efficiently answer term/phrase queries and rank matches, without requiring embeddings.

Pros:

- local and already aligned with Junior's SQLite dependency;
- cheap to rebuild and inspect;
- explainable matches by terms, snippets, and source rows.

Cons:

- misses semantic matches when words differ;
- requires explicit index update/rebuild discipline;
- does not solve summarization, contradiction detection, or lesson promotion by itself.

### MemGPT / Letta

[MemGPT](https://arxiv.org/abs/2310.08560) and [Letta](https://docs.letta.com/guides/agents/architectures/memgpt) model agent memory as context management with in-context core memory plus external recall/archival memory.

Pros:

- strong framing for memory tiers and context-window pressure;
- useful pattern for persistent, personalized agents;
- validates memory tools as a first-class agent interface.

Cons:

- agent-directed memory editing is too much autonomy for Junior v1;
- unsafe unless every write has provenance and review/rollback;
- more framework than Junior needs before proving recall value.

### Generative Agents

[Generative Agents](https://arxiv.org/abs/2304.03442) uses a memory stream, retrieval, reflection, and planning. The event-to-lesson shape in this doc is closest to that architecture.

Pros:

- validates "raw observations first, reflections later";
- useful model for promoting repeated events into lessons;
- separates episodic records from higher-level summaries.

Cons:

- optimized for believable simulation, not operational correctness;
- reflection can invent false lessons without source constraints;
- should influence Junior's consolidation path, not v1 ingestion.

### Zep / Graphiti

[Zep](https://help.getzep.com/v2/memory) and the [Zep temporal knowledge graph paper](https://arxiv.org/abs/2501.13956) are relevant to temporal facts and changing relationships.

Pros:

- strong fit for facts that change over time;
- temporal edges help avoid stale-memory failures;
- graph shape is useful once relationships become the dominant recall need.

Cons:

- graph extraction and reconciliation are complex;
- structured mistakes are harder to unwind than raw event logs;
- likely premature until Junior has enough sourced memory to know which relationships matter.

### Mem0

[Mem0](https://docs.mem0.ai/overview) is a production memory layer for AI applications.

Pros:

- operationally packaged;
- useful reference for memory APIs, async ingestion, reranking, and product boundaries;
- good benchmark for what a hosted memory layer provides.

Cons:

- managed/vector/graph infrastructure cuts against Junior's local-first v1;
- less inspectable than a local source-backed SQLite store;
- introduces vendor and security review questions before the core need is proven.

### GraphRAG

[Microsoft GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/) combines extraction, graph analysis, retrieval, prompting, and summarization over private text corpora.

Pros:

- useful when answers depend on relationships across many documents/events;
- strong reference for graph + summary retrieval;
- relevant to future global memory synthesis.

Cons:

- heavier than needed for per-thread Slack recall;
- optimized for corpus QA, not dispatch-time operational decisions;
- should be treated as v2/v3 inspiration after measured recall gaps.

## Proposed Architecture

```text
Slack messages / replies
  ↓
Raw event writer
  ↓
Event classifier / extractor
  - tags
  - entities
  - outcomes
  - importance
  - relationships
  ↓
SQLite memory store
  - events
  - thread summaries
  - lessons
  - tags/entities
  - edges
  - FTS5 index
  ↓
Recall tool
  1. small LLM expands query into terms/tags/entities
  2. SQLite FTS + tag/entity lookup finds seed nodes
  3. recursive CTE walks edges 1–3 hops
  4. TypeScript scoring ranks candidates
  5. small LLM returns concise sourced snippets
  ↓
Main Junior session receives only top relevant memories
```

The classifier can run through a hook, provider event stream, or scheduled job. It should produce raw, provenance-backed records first and derived tags/edges second.

## Recommended V1

Build the first version as a boring, inspectable memory event log before making recall clever.

1. Add a separate `MemoryStore` backed by the existing SQLite file or a sibling SQLite file.
2. Capture raw Slack messages, runner outputs, routing decisions, and explicit user corrections as append-only source records.
3. Extract only low-risk deterministic metadata first: channel, thread, sender kind, command, agent, repo, timestamps, Slack source links, and message text.
4. Add manual or test-fixture memory facts before live LLM extraction, so recall and routing can be tested against known-good records.
5. Add FTS search over source-backed event and lesson text with an explicit sync/rebuild path.
6. Add bounded tag/entity lookup and edge traversal only after the source record and FTS path are easy to inspect.
7. Feed top-k sourced snippets into Junior only through a tool/provider boundary, not by mutating session prompts globally.

V1 success means Junior can answer "what prior sourced facts might matter here?" with a short, inspectable result. It does not need autonomous learning, embeddings, graph infrastructure, or unsupervised lesson promotion.

## Recommended V2

Once V1 has useful records and real misses, add higher-order memory behavior:

1. LLM extraction for events, lessons, tags, entities, and relationships with provenance on every derived field.
2. Scheduled consolidation that promotes repeated events into lessons and archives low-value source events from the active recall set.
3. Routing-specific memories for repo aliases, user preferences, and prior dispatch corrections.
4. Optional embeddings as a rebuildable cache if lexical and symbolic recall miss too much.
5. Offline rule-learning experiments after enough accepted/rejected classifications exist.

V2 should optimize quality and operator leverage. It should still keep raw source records authoritative and derived memory rebuildable.

## Data Sizes

### Raw Slack Message

Keep as received. This is the audit source and should not be over-normalized.

### Thread / Session Summary

Purpose: capture full context when individual events are too small.

Recommended size: **200–800 words**.

One thread summary should link to its extracted events and lessons.

### Event

An event is one atomic meaningful thing that happened: a request, decision, blocker, correction, outcome, or notable exchange.

Recommended size: **1–5 sentences, roughly 50–250 words**.

Good event example:

> During memory architecture discussion, the user rejected vector DBs because changed data would require re-embedding. Outcome: Junior recommended SQLite FTS + tags/entities + an edge table + TypeScript scoring instead.

Avoid events that are too small:

> User said "ok".

Avoid events that are too large:

> Entire 80-message Slack thread as one event.

Rule: **one decision, blocker, correction, request, outcome, or notable exchange = one event.**

### Lesson

A lesson is generalized knowledge learned from one or more events.

Recommended size: **3–8 sentences, roughly 100–400 words**.

Suggested shape:

```text
Title: Prefer SQLite recall before vector or graph infrastructure

Lesson:
For Junior-scale memory, start with SQLite FTS, structured tags/entities, an edge table, recursive CTE traversal, and TypeScript scoring. Avoid making vector DBs the default substrate because changed data creates re-embedding and freshness work. Avoid graph DBs until relationship traversal is proven to exceed SQLite's capabilities.

Applies when:
- The memory corpus is small/medium.
- Provenance and freshness matter.
- The team wants low ops complexity.

Source events:
- event_...
```

Rule: **events say what happened; lessons say what to do differently next time.**

### Tags and Entities

Tags/entities should be compact and normalized.

Recommended count: **5–15 per event**.

Examples:

```text
person:pranav
system:junior
topic:memory_architecture
topic:recall
storage:sqlite
storage:vector_db
decision:avoid_vector_db_initially
technique:recursive_cte
```

Too few tags cause misses. Too many tags create noise and generic hubs.

### Edges

Edges should be minimal and meaningful. Avoid linking everything to everything.

Useful edge types:

```text
lesson_from
same_topic
follows_up
contradicts
supersedes
mentions
tagged_as
applies_to
```

Generic tags like `bug`, `frontend`, or `question` should not become high-fanout traversal hubs.

## SQLite Schema Sketch

```sql
CREATE TABLE memory_node (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'entity', 'tag')),
  created_at INTEGER NOT NULL
);

CREATE TABLE memory_event (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  summary_id    TEXT,
  body          TEXT NOT NULL,
  outcome       TEXT,
  importance    REAL DEFAULT 0.5,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  use_count     INTEGER DEFAULT 0,
  source_ts     TEXT,
  source_url    TEXT,
  FOREIGN KEY (id) REFERENCES memory_node(id)
);

CREATE TABLE lesson (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  applies_when  TEXT,
  importance    REAL DEFAULT 0.5,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  use_count     INTEGER DEFAULT 0,
  FOREIGN KEY (id) REFERENCES memory_node(id)
);

CREATE TABLE entity (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  kind  TEXT NOT NULL,
  FOREIGN KEY (id) REFERENCES memory_node(id)
);

CREATE TABLE tag (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  FOREIGN KEY (id) REFERENCES memory_node(id)
);

CREATE TABLE memory_tag (
  memory_id TEXT NOT NULL,
  tag_id    TEXT NOT NULL,
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('event', 'lesson', 'summary', 'fact')),
  PRIMARY KEY (memory_id, tag_id)
);

CREATE TABLE mention (
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('event', 'lesson', 'summary', 'fact')),
  PRIMARY KEY (memory_id, entity_id)
);

CREATE TABLE edge (
  src_id     TEXT NOT NULL,
  dst_id     TEXT NOT NULL,
  type       TEXT NOT NULL,
  weight     REAL DEFAULT 1,
  directed   INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src_id, dst_id, type),
  FOREIGN KEY (src_id) REFERENCES memory_node(id),
  FOREIGN KEY (dst_id) REFERENCES memory_node(id)
);

CREATE TABLE memory_search_doc (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact')),
  title      TEXT,
  body       TEXT NOT NULL,
  outcome    TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (id) REFERENCES memory_node(id)
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  id UNINDEXED,
  kind UNINDEXED,
  title,
  body,
  outcome
);

CREATE INDEX edge_src_idx ON edge(src_id);
CREATE INDEX edge_dst_idx ON edge(dst_id);
CREATE INDEX edge_type_src_idx ON edge(type, src_id);
```

`memory_node` keeps ids unambiguous across events, lessons, facts, entities, and tags. `memory_search_doc` is the authoritative search projection; ingestion must either update it transactionally with source writes or run an explicit rebuild job. FTS should be treated as a derived index, never as the source of memory truth.

## Recursive CTE Traversal

Use recursive CTEs for bounded graph-like traversal.

```sql
WITH RECURSIVE related(id, depth, path, score) AS (
  SELECT
    dst_id,
    1,
    src_id || '>' || dst_id,
    weight
  FROM edge
  WHERE src_id IN (?1, ?2, ?3)

  UNION ALL

  SELECT
    e.dst_id,
    r.depth + 1,
    r.path || '>' || e.dst_id,
    r.score * e.weight * 0.7
  FROM edge e
  JOIN related r ON e.src_id = r.id
  WHERE r.depth < 3
)
SELECT id, MAX(score) AS score
FROM related
GROUP BY id
ORDER BY score DESC
LIMIT 20;
```

This is "spreading activation lite": closer nodes score higher, stronger edges score higher, deeper hops decay, and max depth prevents runaway traversal.

## Performance Expectations

Performance is controlled by:

```text
seed count × average edges per node × traversal depth
```

Expected behavior:

- hundreds to low thousands of events: effectively instant;
- 10k–50k events with indexed edges/tags: likely tens of milliseconds for bounded traversal;
- 100k+ dense graph: depends on edge fanout and may need more aggressive caps.

Controls:

1. cap depth at 2 by default, 3 for explicit deep recall;
2. cap seeds to top 10–30 from FTS/tag/entity lookup;
3. cap fanout per node/type, especially `same_topic` or `similar`;
4. index `edge.src_id`, `edge.dst_id`, and `(type, src_id)`;
5. stop expanding low-score paths;
6. avoid traversing from generic tags.

Even 100–300ms recall latency is acceptable if it replaces manual context loading and returns only useful snippets.

## Ranking Model

Use TypeScript scoring over candidates:

```text
score =
  ftsScore
  + exactTagEntityMatch
  + edgeActivation
  + recency
  + importance
  + frequency
```

Start simple and keep each term explainable. The recall output should include why a memory surfaced, for example:

```text
Matched because: exact entity `junior`, tag `memory_architecture`, edge `lesson_from`, high importance, recent discussion.
```

## MVP Build Order

1. Define raw event, lesson, tag/entity, and edge schemas.
2. Write event extraction for Slack thread turns.
3. Add SQLite FTS5 search over event and lesson text.
4. Add tag/entity seed lookup.
5. Add recursive CTE edge expansion with depth/fanout caps.
6. Add TypeScript scoring and explanation traces.
7. Add recall tool interface that returns top-k snippets to Junior.
8. Add scheduled consolidation later: summarize, promote lessons, prune noisy edges, and archive low-value events.

## Future: Ingestion Rule Learning

Once the system has enough classified events and corrections, use [Memory Ingestion Rule Learning](memory-ingestion-rule-learning.md) to learn candidate symbolic rules for tag generation, event type classification, edge creation, and promotion decisions. This should run offline: learned rules start as drafts, are reviewed or strictly gated, and only accepted rules enter the online ingestion path.

## Fit With the Larger Memory Plan

This design still fits the associative-memory direction:

- raw events are the episodic source layer;
- tags/entities are the symbolic index;
- edges are the associative links;
- recursive CTEs provide practical graph traversal;
- TypeScript scoring replaces a formal logic runtime;
- the recall LLM is the query-expansion and snippet-selection layer;
- later consolidation can promote events into lessons and keep the active set small.

The main change from the broader research plan is sequencing: **make vectors optional and graph infrastructure unnecessary until measured need appears.**
