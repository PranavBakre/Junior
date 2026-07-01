# Code Index: Memory System (v3)

Feature doc: [memory-system-v3.md](../features/memory-system-v3.md). The legacy associative layer (events/edges/FTS/rules) has been retired; recall is cosine-only over an embedded claim store, with keyed markdown entity profiles and an offline LLM consolidation engine.

## Source files

### Core store
- `src/memory/types.ts` — Public types: `MemorySourceRecord`; v3 `ClaimInput`/`ClaimRecallOptions`/`ClaimRecallResult`/`ClaimVectorExport`; `EpisodeInput`; decay types (`ArchiveStaleClaimsOptions`, `MemoryHealth`); consolidation read options (`UnconsolidatedSourceRecordOptions`). Also the legacy `MemoryLessonInput`/`MemoryFactInput` still used by `add-lesson`/`add-fact`.
- `src/memory/store.ts` — `MemoryStore` interface (the provider boundary): `appendSourceRecord`, `upsertLesson`/`upsertFact`, `upsertClaim`, `appendEpisode`, `listUnconsolidatedSourceRecords`, `markSourceRecordsConsolidated`, `recallClaims`, `exportClaimVectors`, `markEpisodesUsed`, `archiveStaleClaims`, `memoryHealth`.
- `src/memory/sqlite.ts` — `SqliteMemoryStore` (the only impl). Owns the schema (`memory_source_record`, `memory_node`, `claim`, `episode`, `recall_log`, plus retained tag/provenance tables); `recallClaims` does SQL `WHERE` pre-filter then **brute-force cosine in TS** weighted by `weight`, bumping `last_used_at` unless `recordUsage:false`; `archiveStaleClaims` archives stale **and** low-value claims (`active=0`, never deletes); `memoryHealth` reports per-kind corpus/never-used/fade-candidate counts. Float32-LE BLOB (de)serialization + `cosineSim` helpers live here. `ensureMemoryNodeAllowsClaim` retrofits the `kind` CHECK on pre-v3 DBs.
- `src/memory/factory.ts` — `createMemoryStore(dbPath = "data/memory.db")` → `SqliteMemoryStore`.
- `src/memory/ingestion.ts` — `MemoryIngestor`: hot-path capture. `captureSlackMessage` / `captureRunnerResult` / `captureRoutingDecision` / `captureRunnerEvents` write **only** `appendSourceRecord` (raw provenance — not recallable). Plus `sourceIdFor`/`slug` helpers.
- `src/memory/cli.ts` — `runMemoryCli`: commands `consolidate-v3` (runs `runConsolidationSweep`), `recall-claims` (`--query` embeds in-process; inspection — `recordUsage:false`), `add-claim`, `add-lesson`, `add-fact` (the `add-*` commands **mirror** into the claim store via `mirrorClaim` so new lessons/facts are immediately recallable).
- `src/memory/migrate-v3.ts` — One-shot, committed, dry-run-by-default migration: legacy `lesson`+`memory_fact` → embedded `claim` (proximity-dedup), then `dropCondemned`-gated DROP of `memory_event`/`edge`/`mention`/`memory_search_doc`/`candidate_rule`/`memory_fts`. Cutover is complete.

### Embeddings (`src/memory/embedding/`)
- `local.ts` — `LocalEmbeddingProvider`: in-process `onnx-community/harrier-oss-v1-270m-ONNX` (640-dim, q8) via `@huggingface/transformers`. Last-token pooling (reads the model's `sentence_embedding` output), query-vs-document prompt templates, one text per forward pass (no padded batches).
- `hashing.ts` — `HashingEmbeddingProvider`: deterministic zero-dependency stub for tests/dev.
- `factory.ts` — `createEmbeddingProvider("local" | "hashing")`.
- `types.ts` — `EmbeddingProvider` / `EmbedMode` ("query" | "document").

### Profiles (`src/memory/profiles/`) — keyed, markdown, not embedded
- `store.ts` — `ProfileStore`: files at `<root>/<people|repos|situations>/<slug>.md`; `upsertProfile` (keyed merge by `entity_ref`, unions evidence, bumps `updated_at`), `fetchByEntityRef` (single keyed read; bumps `last_used_at` only when `recordUsage:true`), `list`. Profile↔markdown mapping + field specs per kind.
- `types.ts` — `ProfileKind` (person/repo/situation), `Profile`/`ProfileBase`/`ProfileInput`, `ProfileFetchOptions`.
- `frontmatter.ts` — `parseDocument`/`serializeDocument` (frontmatter + prose body).
- `factory.ts` — `createProfileStore`. `index.ts` — barrel.

### Consolidation engine (`src/memory/consolidation/`) — offline LLM write path
- `consolidate.ts` — `consolidateSession`: uses a pre-fetched `records` set when given (else reads unconsolidated records by `threadId`/`limit`), builds context (existing profiles + nearby claims), calls the injected LLM (forwarding `bodyCap` to the prompt), persists **episodes → profiles → claims** (cosine proximity-dedup at `DEFAULT_DEDUP_THRESHOLD = 0.92`), stamps records consolidated. Local `cosine` + `fnv1a` (stable 64-bit claim id) helpers.
- `sweep.ts` — `runConsolidationSweep`: the shared orchestration loop. Full-sweep mode fetches all unconsolidated records once, FILTERS to allowed `kinds` (`DEFAULT_CONSOLIDATION_KINDS` = `slack_message`/`curated_fact`/`manual_correction`; excluded kinds like `runner_output`/`routing_decision` are deferred, never marked), groups by thread (unthreaded → `(unthreaded)`), SPLITS any group whose body-capped size exceeds `maxBatchChars` into consecutive ≤budget sub-chunks (`splitGroup`; a lone over-budget record is its own chunk), then First-Fit-Decreasing bin-packs the remaining groups by body-capped char total (`DEFAULT_MAX_BATCH_CHARS` 48000, `DEFAULT_BODY_CAP` 2000) so several threads share one runner call; threads stay contiguous, each batch is isolated on failure. `threadId` mode keeps the single-thread `limit` path (no kind filter). Entries carry `threadIds: string[]`. `summarizeConsolidationSweep` for human output. Used by the CLI, the workflow, and the MCP tool.
- `runner.ts` — `createRunnerInvoke`: production `ConsolidationInvoke`. `runner: "claude" | "opencode" | "codex"` (default `opencode`) selects the one-shot subprocess (injectable `runText`): `opencode run --model <m> --format json "<prompt>"` (`openCodeRunText`); `claude -p … --output-format json` (`defaultRunText`); or `codex exec` (`codexRunText` + `buildCodexConsolidationArgs`) fully isolated (`--ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only --color never`), run from a neutral cwd (`os.tmpdir()`) with the prompt on **stdin** and the final message read from a unique `-o` temp file (deleted after) — isolation is required or junior's Stop/learnings hooks hijack the output. The model is ALWAYS pinned — `DEFAULT_OPENCODE_MODEL = opencode-go/deepseek-v4-pro`, `DEFAULT_CLAUDE_MODEL = claude-opus-4-6` (a VALID id; `sanitizeClaudeModel` defensively strips a trailing `[…]` tag like junior's `[1M]` notation), `DEFAULT_CODEX_MODEL = gpt-5.5` with `effort` default `low` (`-c model_reasoning_effort="…"`). Output is parsed/validated against `consolidationOutputSchema`; 5-min timeout guard SIGINTs the process tree.
- `prompt.ts` — `buildConsolidationPrompt(records, context, bodyCap?)`: encodes the HIGH BAR (default output is empty) + shows existing profiles/claims to avoid restating; notes records may span multiple `thread=` groups (judge each on its own). With `bodyCap` set it truncates ONLY `BODY_CAPPED_KINDS` (`runner_output`/`routing_decision`) bodies (`…[truncated]`); high-value kinds go in whole. `cappedBodyLength()` is the shared sizing helper the sweep uses so packing matches what is sent.
- `types.ts` — `EpisodeDraft`/`ProfileDraft`/`ClaimDraft`, `ConsolidationOutput`/`ConsolidationInvoke`, `ConsolidationReport`, and `consolidationOutputSchema` (JSON Schema). `index.ts` — barrel.

## Integration points (outside `src/memory/`)
- `src/index.ts` — builds the store + `MemoryIngestor` on boot, injects the ingestor into the session manager.
- `src/session/manager.ts` — hot path: `captureSlackMessage` on incoming messages, `captureRunnerResult` on runner completion.
- `src/mcp/slack-server.ts` — MCP tools `memory_recall` (`recallMemory`: keyed profiles + cosine claim recall), `memory_add` (`addMemory`: embed + store one claim), `memory_consolidate` (`runConsolidationSweep`). Lazy embedder/profile-store seams; `withMemoryStore` opens/closes per call.
- `src/workflows/executor.ts` — the `memory-consolidation` workflow runs `runConsolidationSweep` (sweep IS the LLM pass).
- `src/http/routes/memory.ts` — dashboard: `handleMemoryRecall` (embeds query at the boundary, `recordUsage:false`), `handleMemoryProjection` (`exportClaimVectors` → `projectClaims`), plus `/api/memory` docs browsing.
- `src/http/projection.ts` — `projectClaims`: PCA-to-2D + KNN edges for the "memory cloud" debug view (computed at render time, nothing stored).

## Migrations
- `src/memory/migrations/2026-06-13-prune-routing-decision-logs.ts` — committed offline maintenance script (`bun run migrate:prune-routing-logs`).

## Tests
- `sqlite.test.ts`, `cli.test.ts`, `ingestion.test.ts`, `migrate-v3.test.ts`; `embedding/embedding.test.ts`; `profiles/profiles.test.ts`; `consolidation/{consolidate,runner,sweep}.test.ts`. Tests inject the hashing embedder + a fake `ConsolidationInvoke` + a temp profile store so they never load model weights or spawn a real CLI.
