# Code Index: Associative Memory

## Source files

- `src/memory/types.ts` — TypeScript representations of source records, node/search kinds, event inputs, and search results.
- `src/memory/store.ts` — `MemoryStore` provider boundary for append-only source capture, derived event writes, FTS search, and index rebuilds.
- `src/memory/factory.ts` — Small factory for creating the default SQLite memory store (`data/memory.db`).
- `src/memory/sqlite.ts` — SQLite-backed memory store. Creates the schema from `docs/features/associative-memory.md`, keeps `memory_source_record` append-only, writes derived event/lesson/fact rows, maintains `memory_search_doc`, syncs the rebuildable `memory_fts` index transactionally, performs tag/entity recall, bounded edge traversal, supersession filtering, ingestion logging, correction logging, draft rule storage, and deterministic consolidation.
- `src/memory/sqlite.test.ts` — Store tests for schema creation, source/event separation, FTS sync, and FTS rebuild.
- `workflows/memory-consolidation.workflow.md` — Operator-triggered workflow shell for the offline V2 consolidation/dreaming pass.

## Data flow implemented so far

```text
raw source record
  -> memory_source_record
derived event / lesson / fact
  -> memory_node + memory_event / lesson / memory_fact
  -> memory_tag / mention / edge / memory_provenance
  -> memory_search_doc
  -> memory_fts
recall(query/tags/entities)
  -> FTS seeds + tag/entity seeds + recursive edge expansion
  -> TypeScript score + explanation trace + source ids
consolidate()
  -> archive cold events
  -> promote repeated corrections to routing memories
  -> propose draft bounded-DSL ingestion rules
```

## Current scope

Implemented scope covers the V1 store/recall path and a deterministic V2 consolidation scaffold:

- V1: source capture, derived event/lesson/fact writes, FTS search/rebuild, tag/entity lookup, bounded recursive edge traversal, TypeScript scoring, explanation traces, and source ids.
- V2 scaffold: ingestion classification/correction logs, consolidation decisions, low-value archive, repeated-correction routing-memory promotion, and draft bounded-DSL rule proposals.

Not yet implemented: live Slack hot-path capture wiring, LLM extraction, embeddings, accepted learned-rule execution, and automatic scheduled workflow execution beyond the workflow definition.
