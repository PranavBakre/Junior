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

The broader research plan still matters, but it should be sequenced:

- V1 proves sourced recall with raw capture, FTS, tags/entities, bounded edge traversal, and explainable scoring.
- V2 adds the consolidation/"dreaming" engine: classify recent records, promote durable lessons, archive low-value events from the active set, strengthen/prune edges, and handle stale facts.
- V3 can add richer hybrid retrieval such as local embeddings, Personalized PageRank-style spreading activation, hierarchical summaries, and learned ingestion rules once measured recall gaps justify them.

## Why Not a Vector DB First

Avoid making embeddings the foundation.

- Changed memory requires re-embedding changed rows.
- Embeddings become another stale derived cache to version and rebuild.
- Vector similarity is opaque compared with tags/entities/edges and source-backed snippets.
- Junior-scale memory likely fits lexical search + structured metadata for a long time.

Embeddings can be added later as an optional acceleration layer if recall misses too much. If added, they should be derived/rebuildable, not authoritative.

This is a rejection of a vector database as the default substrate, not a rejection of local embeddings forever. A future SQLite-backed vector table, such as `sqlite-vec`, can be a rebuildable fuzzy-entry cache beside FTS and symbolic lookup. Raw source records, derived nodes, and provenance remain authoritative.

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

## Dictionary and Alias Population

Deterministic recall depends on dictionaries: repo names, aliases, tag synonyms, entity names, and phrase expansions. The dictionary is not magic and should not be treated as an unsourced prompt blob. It is memory too: every non-static entry needs provenance, confidence, validity timestamps, and supersession.

Dictionary entries come from four sources, in order of trust:

### 1. Static config and known system data

Seed the first dictionary from Junior's configured world:

- `REPOS` entries and repo metadata;
- known agent names and aliases (`build`, `frontend`, `review`, `lead`, `reproducer`, `thinker`);
- known Slack channels/users where available;
- command names and directive syntax;
- file extensions and common stack hints.

Examples:

```text
gx-backend       -> repo:gql-backend/gx-backend equivalent if configured
gx-admin-client -> repo:gx-admin-client
gx-client-next  -> repo:gx-client-next
PR              -> task_type:review
.tsx            -> technology:frontend
```

These entries are deterministic and can be rebuilt from config.

### 2. Curated operator facts

Operators can add high-confidence aliases and preferences when they are known:

```text
"dashboard"       -> repo:gx-admin-client
"admin dashboard" -> repo:gx-admin-client
"web app"         -> repo:gx-client-next
"API"             -> repo:gx-backend
```

Curated entries should be rare, sourced to the operator action that created them, and treated as durable until superseded.

### 3. Accepted corrections

Corrections are the best learning signal. If a user says "No, dashboard means admin client," store that as a correction source record. The consolidation engine can later promote it into a dictionary/routing-memory entry:

```text
alias("dashboard", repo:gx-admin-client)
confidence: 0.9
source: correction_event_...
```

### 4. Dreaming-generated proposals

The consolidation job may propose dictionary entries from repeated usage:

```json
{
  "type": "alias_candidate",
  "phrase": "dashboard",
  "mapsTo": "gx-admin-client",
  "targetType": "repo",
  "confidence": 0.82,
  "evidence": ["event_1", "event_7", "correction_2"]
}
```

These start as drafts. Promote them only after held-out replay, high-confidence gating, or human review. Learned aliases influence recall/routing as evidence, not as direct commands.

### Storage shape

Dictionary entries can be stored as `memory_fact` / `routing_memory` rows plus tags/edges, or as a dedicated projection over those facts. The important fields are:

```text
phrase
target_type: repo | tag | entity | task_type | agent | technology
target_id
confidence
source_ids
valid_at
invalid_at
superseded_by
```

If an alias changes meaning, do not overwrite it. Mark the old entry invalid and create a `supersedes` edge from the new entry to the old one. Current recall filters invalid aliases by default; historical audit can still inspect them.

## Memory Classes

The source store should make the memory tiers explicit. These are raw memory classes in the database, not file-format requirements.

### Curated Fact

Manually approved durable knowledge: operator preferences, stable project facts, trusted repo aliases, or safety rules. Curated facts should be rare, high-confidence, and sourced to the correction, approval, or configuration that created them.

### Episodic Event

A timestamped thing that happened: a Slack request, blocker, decision, correction, runner result, route, or notable outcome. Episodic events are the main audit trail for "what happened before?".

### Thread / Session Summary

A compressed record of a whole Slack thread or agent session when individual events are too small to preserve the context. Summaries should link to their source records and derived events.

### Semantic Lesson

Reusable knowledge generalized from one or more events. Lessons answer "what should Junior do differently next time?" and should always keep `lesson_from` provenance.

### Procedural Memory

A repeatable playbook or workflow, such as how to reproduce a bug class or prepare a repo. Procedural memories are future-facing; v1 can store them as facts/lessons, but the schema should not make them impossible later.

### Routing Memory

Repo aliases, user preferences, channel patterns, task patterns, and prior routing corrections. These feed agent selection as evidence, not as direct dispatch commands.

### Correction

An explicit user/operator/agent correction to a fact, route, tag, outcome, edge, or lesson. Corrections are high-value source records because they prevent repeated mistakes and provide labeled examples for future rule learning.

Raw capture can be broad, but active recall should be selective. The hot set should prefer recent, important, unresolved, frequently reused, or manually curated memories. Low-value events should remain searchable for audit but should not eagerly enter the main agent context.

## Identity and Deduplication

The schema tracks `use_count`, but the ingestion path must say *how* repeated information collapses — otherwise the same fact arriving five times becomes five nodes, inflating recall noise and fragmenting the signal `use_count` is meant to carry. This is distinct from supersession: **dedup handles the *same* fact seen again; supersession handles a fact that *changed*.**

Rules of thumb:

- **Source records are always append-only.** Every raw Slack message / runner output is its own `memory_source_record`. Never dedup the audit layer — provenance depends on it.
- **Derived nodes dedup against an identity key.** When extraction produces a derived event/fact/lesson, compute a normalized identity key (e.g. normalized claim text, or `(entity, predicate, normalized_value)` for facts). If a live node already matches the key, do not create a new node — instead bump `use_count`, refresh `last_used_at`, and append the new `source_record_id` to its provenance.
- **Near-duplicates are a consolidation job, not a hot-path job.** Exact/normalized-key matches can merge cheaply at ingest. Fuzzy "these two say the same thing" merges belong in the offline dreaming pass, which can also strengthen the edge between them rather than collapse them if they are merely related.
- **A changed value triggers supersession, not dedup.** If the identity key matches on entity but the value differs (phone number changed), mark the old node `invalid_at` and link `supersedes` — keep both for temporal audit.

Without this, `frequency` in the ranking model is measuring "how many duplicate rows we failed to merge," not "how often this actually recurred."

## Recommended V1

Build the first version as a boring, inspectable memory event log before making recall clever.

1. Add a separate `MemoryStore` backed by the existing SQLite file or a sibling SQLite file.
2. Capture raw Slack messages, runner outputs, routing decisions, and explicit user corrections as append-only source records.
3. Derive `memory_event` rows from those source records; do not treat extracted events as the raw audit source.
4. Add manual or test-fixture memory facts before live LLM extraction, so recall and routing can be tested against known-good records.
5. Add FTS search over source-backed event and lesson text with an explicit sync/rebuild path.
6. Add bounded tag/entity lookup and edge traversal only after the source record and FTS path are easy to inspect.
7. Feed top-k sourced snippets into Junior only through a tool/provider boundary, not by mutating session prompts globally.

V1 success means Junior can answer "what prior sourced facts might matter here?" with a short, inspectable result. It does not need autonomous learning, embeddings, graph infrastructure, or unsupervised lesson promotion.

> **Expectation to set up front: v1 will not feel "associative" yet.** Until the consolidation/dreaming pass has produced a real edge set, recall is effectively FTS + tag/entity lookup. The spreading-activation behavior — surfacing a memory you didn't search for because it is linked to one you did — only emerges once edges exist. Bet the early experience on *sourced, inspectable* recall, not on associative leaps, and let the graph earn its keep over time.

## Recommended V2

Once V1 has useful records and real misses, add the consolidation/"dreaming" engine and higher-order memory behavior:

1. LLM extraction for events, lessons, tags, entities, and relationships with provenance on every derived field.
2. Scheduled consolidation that promotes repeated events into lessons and archives low-value source events from the active recall set.
3. Routing-specific memories for repo aliases, user preferences, and prior dispatch corrections.
4. Optional embeddings as a rebuildable cache if lexical and symbolic recall miss too much.
5. Offline rule-learning experiments after enough accepted/rejected classifications exist.

V2 should optimize quality and operator leverage. It should still keep raw source records authoritative and derived memory rebuildable.

The V2 consolidation engine is the implementation form of "dreaming":

1. replay recent source records and episodic events while Junior is idle or on a schedule;
2. classify and summarize records that deterministic extraction could not safely handle;
3. promote repeated or high-importance patterns into semantic lessons and curated/routing facts;
4. archive low-value events out of the active recall set without deleting the audit source;
5. strengthen useful edges, prune noisy edges, and create `supersedes` / `contradicts` links for stale facts;
6. record provenance for every derived field and explanation for every promotion/archive decision.

Do not run this work on every Slack message. The hot path should store raw records cheaply and retrieve only top-k snippets; expensive extraction, reflection, and rule learning belong in scheduled or operator-triggered jobs.

Junior's dynamic workflow system is the right execution surface for this engine. The memory consolidation job can be a scheduled and on-demand workflow, for example `workflows/memory-consolidation.workflow.md`, with `concurrency: skip`, owner/admin controls, run artifacts under `data/workflow-runs/memory-consolidation`, and optional Slack summaries. The workflow should call memory-specific code/tools rather than embedding all consolidation logic in the markdown prompt. If workflow permissions need to be extended, add narrow capabilities such as `memory.read`, `memory.write`, and `memory.evaluate` instead of granting broad filesystem or database access.

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
CREATE TABLE memory_source_record (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (
                   kind IN (
                     'slack_message',
                     'runner_output',
                     'routing_decision',
                     'routing_correction',
                     'ingestion_correction',
                     'curated_fact',
                     'manual_correction'
                   )
                 ),
  channel_id     TEXT,
  thread_id      TEXT,
  slack_ts       TEXT,
  source_url     TEXT,
  actor_id       TEXT,
  actor_kind     TEXT CHECK (actor_kind IN ('human', 'junior', 'agent', 'bot', 'system')),
  agent_name     TEXT,
  repo_name      TEXT,
  body           TEXT NOT NULL,
  metadata_json  TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE memory_node (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (
               kind IN (
                 'event',
                 'lesson',
                 'summary',
                 'fact',
                 'procedure',
                 'routing_memory',
                 'entity',
                 'tag'
               )
             ),
  created_at INTEGER NOT NULL,
  valid_at   INTEGER,
  invalid_at INTEGER,
  superseded_by TEXT
);

CREATE TABLE memory_event (
  id            TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  summary_id    TEXT,
  body          TEXT NOT NULL,
  outcome       TEXT,
  importance    REAL DEFAULT 0.5,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  use_count     INTEGER DEFAULT 0,
  active        INTEGER DEFAULT 1,
  source_ts     TEXT,
  source_url    TEXT,
  FOREIGN KEY (source_record_id) REFERENCES memory_source_record(id),
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
  active        INTEGER DEFAULT 1,
  FOREIGN KEY (id) REFERENCES memory_node(id)
);

CREATE TABLE memory_fact (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (
                  kind IN ('curated_fact', 'routing_memory', 'procedure')
                ),
  title         TEXT,
  body          TEXT NOT NULL,
  confidence    REAL DEFAULT 0.5,
  importance    REAL DEFAULT 0.5,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  use_count     INTEGER DEFAULT 0,
  active        INTEGER DEFAULT 1,
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
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory')),
  PRIMARY KEY (memory_id, tag_id)
);

CREATE TABLE mention (
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory')),
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
  kind       TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory')),
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

`memory_source_record` is the raw audit layer: Slack messages, runner outputs, routing decisions, curated facts, and corrections are stored before extraction. `memory_event` is derived from source records and should always point back to one. `memory_node` keeps ids unambiguous across events, lessons, summaries, facts, procedures, routing memories, entities, and tags. `valid_at`, `invalid_at`, and `superseded_by` let recall suppress stale facts by default while preserving historical audit.

`memory_search_doc` is the authoritative search projection. The FTS table is a derived index and should be maintained in one of two explicit ways:

1. Transactional sync: whenever ingestion writes or updates `memory_search_doc`, the same transaction updates `memory_fts`.
2. Rebuild sync: a rebuild job deletes and repopulates `memory_fts` from `memory_search_doc`.

Do not let `memory_fts` become the only place searchable memory text exists.

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

If recall quality later depends on many weak paths converging on the same memory, upgrade this traversal to an in-process spreading-activation or Personalized PageRank-style pass over a bounded candidate graph. Keep the recursive CTE path as the simple v1 implementation until measured misses prove it insufficient.

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
7. require allow-listed specific tags/entities, or strict fanout caps, before traversing outward from tag/entity nodes.

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

## Usage and Cost Model

Memory should reduce main-session context pressure rather than add a model call to every event.

V1 hot path should be cheap:

1. store raw Slack messages, runner outputs, routes, and corrections without an LLM call;
2. write SQLite rows and derived FTS/search projections;
3. run FTS/tag/entity lookup and bounded edge traversal;
4. return only top-k sourced snippets to the main session.

The expensive work belongs off the hot path:

- LLM event extraction;
- importance scoring when deterministic signals are not enough;
- thread summarization;
- lesson/reflection generation;
- contradiction detection;
- routing-memory extraction;
- offline rule-learning and evaluation.

The rule is: **never call an LLM just to decide whether to store raw memory**. Store raw records cheaply, then classify, promote, summarize, and learn from them in scheduled or operator-triggered jobs. This keeps per-message latency and model usage bounded while still letting recall improve over time.

## Benchmarks and Evaluation

Build a small Junior-specific eval before borrowing academic benchmarks. The first eval set should use real or fixture Slack threads with expected memory ids, expected route/repo when relevant, and known stale memories that must not be returned.

Minimum eval row:

```text
id
query_or_message
expected_memory_ids
expected_agent
expected_repo
must_not_return_memory_ids
case_type: direct | multi_hop | stale_fact | routing | correction
```

### Recall Quality

Track:

- `recall@3`, `recall@5`, and `recall@10`: whether the expected memory appears in the top-k results.
- useful recall rate: of memories surfaced to Junior, how many were used in the answer, route, or operator-facing reason.
- stale-fact suppression: corrected or superseded facts should not appear for current queries unless the query is explicitly historical.
- multi-hop recall: queries should surface memories linked through user, repo, task, blocker, or lesson edges, not only direct keyword matches.
- correction learning: after a correction is stored, a similar replay should route/tag/recall differently.

### Routing Quality

Replay historical routing messages with and without memory evidence:

- selected agent accuracy;
- selected repo accuracy;
- clarification rate for intentionally ambiguous messages;
- explicit-command preservation, where memory must not override the user's command;
- stale routing preference suppression after a repo alias or user preference is superseded.

### Cost and Performance

Track:

- p50/p95 recall latency before any LLM snippet-selection step;
- number of source records, nodes, and edges considered;
- number of snippets injected into the main session;
- tokens added to the main prompt;
- model calls per Slack message;
- model calls per consolidation workflow run;
- estimated cost per 100 Slack messages;
- SQLite DB size, FTS rebuild time, and consolidation workflow runtime for the last 24 hours and 7 days.

### Suggested V1 Gates

```text
recall@5 >= 80% on curated eval
stale-fact failures = 0 on known corrections
useful recall rate >= 60%
p95 recall latency < 300ms before LLM snippet selection
0 LLM calls required for raw capture
top-k injected memory <= 8 snippets
```

### Suggested V2 Gates

```text
consolidation reduces active recall set size by 30-60%
recall@5 does not regress after archiving
lesson promotion precision >= 80% on reviewed samples
routing accuracy improves over non-memory baseline
LLM extraction calls per message trend down as accepted rules improve
```

## MVP Build Order

1. Define `memory_source_record`, `memory_node`, event, lesson, fact/procedure/routing-memory, tag/entity, edge, and search-projection schemas.
2. Write append-only source capture for Slack messages, runner outputs, routing decisions, and corrections.
3. Derive events from source records with deterministic metadata first.
4. Add SQLite FTS5 search over `memory_search_doc`, with transactional sync or rebuild sync.
5. Add tag/entity seed lookup.
6. Add recursive CTE edge expansion with depth/fanout caps and tag/entity traversal controls.
7. Add TypeScript scoring and explanation traces.
8. Add recall tool interface that returns top-k snippets to Junior.
9. Add scheduled consolidation later: summarize, promote lessons, prune noisy edges, mark stale facts, and archive low-value events.

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
