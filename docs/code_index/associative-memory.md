# Code Index: Associative Memory

## Source files

- `src/memory/types.ts` — TypeScript representations of source records, node/search kinds, event inputs, and search results.
- `src/memory/store.ts` — `MemoryStore` provider boundary for append-only source capture, derived event writes, FTS search, and index rebuilds.
- `src/memory/factory.ts` — Small factory for creating the default SQLite memory store (`data/memory.db`).
- `src/memory/ingestion.ts` — Hot-path deterministic ingestion service for Slack messages, routing decisions, runner outputs, and notable runner tool errors.
- `src/memory/cli.ts` — CLI tool surface for workflow utility runs: `recall` and `consolidate` against `MEMORY_DB_PATH` / `data/memory.db`.
- `src/memory/sqlite.ts` — SQLite-backed memory store. Creates the schema from `docs/features/associative-memory.md`, keeps `memory_source_record` append-only, writes derived event/lesson/fact rows, maintains `memory_search_doc`, syncs the rebuildable `memory_fts` index transactionally, performs tag/entity recall, bounded edge traversal, supersession filtering, ingestion logging, correction logging, draft rule storage, and deterministic consolidation.
- `src/memory/cli.test.ts` — CLI tests for recall and consolidation against a configured SQLite database.
- `src/memory/sqlite.test.ts` — Store tests for schema creation, source/event separation, FTS sync, FTS rebuild, recall usage, undirected edges, supersession, ingestion logs, and consolidation.
- `src/memory/ingestion.test.ts` — Tests for live Slack message capture, routing decision capture, and runner result capture.
- `src/mcp/slack-server.ts` — Exposes `memory_recall` and `memory_consolidate` MCP tools for normal Junior runner sessions.
- `src/session/manager.ts` — Wires `MemoryIngestor` into live Slack hot path: captures incoming messages, routing decisions, and runner completions via `captureSlackMemory` / `captureRunnerMemory`.
- `src/support/router.ts` — `AgentDispatcher.memorySuggestedAgent`: recalls routing-memory facts to suggest a persistent agent (e.g., `!build`, `!frontend`) for human messages without explicit directives.
- `src/workflows/executor.ts` — Runs memory consolidation natively via `MemoryStore` when a workflow is named `memory-consolidation`, bypassing the runner spawn.
- `src/http/routes/memory.ts` — Dashboard HTTP routes for `GET /api/memory/recall` and `POST /api/memory/consolidate`.
- `workflows/memory-consolidation.workflow.md` — Operator-triggered workflow shell for the offline V2 consolidation/dreaming pass.

## Data flow implemented so far

```text
raw source record
  -> memory_source_record
live Slack/session events
  -> MemoryIngestor
  -> appendSourceRecord + upsertEvent / upsertFact
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
CLI / MCP / HTTP / workflow
  -> recall and consolidation are available to workflows/runners without direct DB edits
  -> workflow executor runs memory-consolidation natively through MemoryStore
memory-suggested routing
  -> AgentDispatcher calls MemoryStore.recall(routing_memory) for unmatched messages
  -> top-k routing-memory haystack checked for persistent-agent name mentions
  -> if matched, dispatches to that agent (e.g., review, build, frontend)
```

## Current scope

Implemented scope covers the V1 store/recall path, live ingestion wiring, a deterministic V2 consolidation scaffold with LLM analysis, and accepted rule execution in live capture:

- V1: source capture, derived event/lesson/fact writes, FTS search/rebuild, tag/entity lookup, bounded recursive edge traversal, TypeScript scoring, explanation traces, and source ids.
- V2 scaffold: ingestion classification/correction logs, consolidation decisions, low-value archive, repeated-correction routing-memory promotion, and draft bounded-DSL rule proposals.
- V2 live: scheduled daily consolidation (native + LLM runner), accepted rule execution in live ingestion (cached, 60s refresh), rule accept/reject via CLI, MCP, and HTTP.

Access surfaces:

- Workflow utility runs: `bun run <runtime context junior.memoryCli> recall --query "..." --json` and `bun run <runtime context junior.memoryCli> consolidate --json`.
- Normal MCP-wired Junior runs: `memory_recall`, `memory_consolidate`, `memory_accept_rule`, `memory_reject_rule`, `memory_accepted_rules`.
- HTTP dashboard: `GET /api/memory/recall`, `POST /api/memory/consolidate`.
- Workflow executor: `memory-consolidation` workflow runs native consolidation then spawns LLM runner for inspection.
- Live ingestion: `SessionManager` captures Slack messages, routing decisions, and runner results through `MemoryIngestor`. Accepted tag rules from consolidation are applied in the hot capture path.

Not yet implemented: LLM embeddings, automatic rule evaluation metrics beyond the consolidation heuristic, and scheduled optimization beyond the daily cron trigger.
