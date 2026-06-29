# Junior Memory System — Lesson Store (v2)

> **Status: SUPERSEDED by [memory-system-v3.md](memory-system-v3.md) (shipped).** v3 keeps this doc's curated/embedded core but generalizes it (episodes, keyed profiles, atomic claims) and, critically, **dropped the parallel FTS+vector recall** described here — production recall is now cosine-only. The `src/memory/eval/` harness referenced below has also been removed (it gated the v3 migration, then was retired). Read this for the v2 lineage and the measurement that justified an embedded store; read v3 for current behavior.
>
> *(Original v2 status:)* Canonical design. Supersedes [memory-system-overhaul.md](memory-system-overhaul.md) (kept as the investigation/evidence record) and retires the "mine Engram for retrieval mechanics" frame. Every decision here traces to a measurement from the recall-eval harness (`src/memory/eval/`), the real codex-log replay, and the [Engram audit](../audits/2026-06-03-engram-memory-review.md).

## TL;DR

Junior's memory becomes a **curated, embedded lesson store**:

- **Write** — every session distills its learnings into durable lessons (high bar; most sessions add nothing). The per-turn learnings-hook model, made first-class.
- **Store** — lesson text + an embedding vector + metadata + a helpfulness weight, in SQLite.
- **Read** — keyword (FTS) and semantic (vector cosine) channels run in **parallel** on every query and merge. No edges, no graph, no traversal.
- **Curate** — dedup and forgetting happen at write time via embedding proximity; helpful/unhelpful feedback weights lessons up or decays them out.
- **Inject** — a handful of universal "always do X" rules go straight into agent instructions; the store serves the situational long tail.

This deletes the event flood, the edge graph, spreading activation, and the RRF/vector-cascade machinery — none of which earned their keep in measurement.

## Why — the evidence

| Finding | Number | Implication |
|---|---|---|
| Real recall traffic mostly returns *something* | **94%** of 365 replayed codex queries return results — but the experiment showed that figure is carried by the **tag channel**, not FTS keyword match | Keep FTS for keyword / exact-identifier lookup; don't read "94%" as "FTS is healthy" |
| Abstract principles don't come back from natural situation queries | **0/7** principle hit — the targets aren't in the index; they live in `CLAUDE.md` / the `common/` preambles | **Not a retrieval gap, and not even an ingestion one — an injection question, now resolved as inject-not-ingest.** `memory_recall`'s only caller is the dispatched runner agent, which *already* receives those principles via the `common/` preamble (deterministic, always-fires). Recall returning them is redundant. Residual heuristics were injected, not ingested. Vectors stay gated behind real `recall_log` evidence of a *situational* residual that lexical (incl. AND→OR) misses — see Phase 1/Phase 3 |
| The event store is mostly write-only noise | **96%** of 6,720 events never recalled once | Stop promoting events to recallable memory |
| Curation barely functions | 57 consolidation decisions ever (2 of 8 actions); **0** supersessions; 640/641 routing memories were generic logs | Rebuild the write/curation path |
| Vector *query* is cheap; the *edge build* is the slow part | 40ms/20k query vs **7.7s/5k** O(N²) edge build (Engram audit) | Vectors yes; associative edge graph no |
| "Returns results" ≠ "returns the right thing" | no relevance labels; association payoff unmeasured | Add a helpful/unhelpful feedback loop to measure it and drive curation |

## The system

### 1. Write path — per-session consolidation (the hook, made first-class)

Raw Slack/runner turns are captured as **source records only** — provenance/evidence, *not* recallable memory. After a session completes, a consolidation step applies the learnings-hook discipline:

- Read the session's source records.
- Ask: did this produce a **durable, reusable lesson** (what to do, when, why)? Default: **nothing**.
- Recall-first: embed the candidate, find nearest existing lessons; if a near-duplicate exists, **merge/update** it instead of creating a new row.
- Write at most a few clean lessons.

This inverts today's "store everything, distill later." Capture stays raw; promotion is judged at the moment of signal, with a high bar.

### 2. Storage — SQLite

One row per lesson:

```
lessons(
  id TEXT PRIMARY KEY,
  title TEXT, body TEXT,        -- the principle: what / when / why
  kind TEXT,                    -- lesson | fact | procedure
  repo TEXT, tags TEXT,         -- metadata for filtered search
  embedding BLOB,               -- Float32 little-endian
  embed_model TEXT, dim INT,    -- so a model change can invalidate/rebuild
  source_session TEXT,          -- provenance (a field, not a graph)
  helpful_count INT, unhelpful_count INT,
  weight REAL DEFAULT 1.0,      -- derived from feedback; gentle
  created_at INT, last_used_at INT, active INT DEFAULT 1
)
```

Text is authoritative; embeddings are derived/rebuildable. `bun:sqlite`, single file, no new service (CLAUDE.md rule 11).

### 3. Read path — FTS ∥ vector, merged

On every recall, run **both channels in parallel** and merge:

- **FTS** over `title/body` — for keyword and **exact-identifier** lookups (repo names, file paths, PR numbers, `support/admin-credentials.yaml`), where lexical match beats semantic.
- **Vector** — embed the query (API), cosine top-k over the lesson embeddings, for **semantic/principle** recall where FTS scores 0%.
- **Merge** the two sets (union / light RRF), apply the lesson `weight`, return top-k.

No FTS-success gate — FTS returning *something* ≠ the *right* something, and a gate silently drops principles. No edges, no traversal. Run FTS and the query-embedding **concurrently** so latency ≈ max(FTS, embed), not the sum; cache query embeddings.

**Filters steer the search:** a SQL `WHERE` (repo / kind / recency / importance) narrows candidates *before* cosine — free and exact under brute-force, and how you scope "only principles for the repo I'm in."

### 4. Curation — dedup & forgetting at write time

- **Dedup:** nearest-neighbor on consolidate → merge near-duplicates (kills the "subagent summaries ×3" problem). Supersession becomes **overwrite**, not a `supersedes` edge.
- **Forget by value, not age:** persistently **unhelpful** or never-recalled lessons decay and archive. The feedback weight, not a fixed TTL, drives forgetting.

### 5. Feedback — helpful / unhelpful (the missing loop)

After a turn that used recalled lessons, a **post-turn judge** (the same learnings-hook mechanism) marks each recalled lesson helpful / unhelpful:

- Helpful → raise `weight` (gentle, reversible) → ranks higher.
- Unhelpful → lower `weight`; sustained, broad unhelpfulness → archive.

This is both the **forgetting driver** and the **only real metric for whether semantic recall pays off** (helpful-rate). Keep weights gentle (avoid rich-get-richer); treat unhelpful as context-specific (decay, don't hard-delete).

### 6. Universal rules — inject, don't retrieve

The handful of always-true rules (3-way merge, gxt-admin for merges, branch-from-main) go **directly into agent instructions** — deterministic, always fire. The embedded store serves the **situational long tail** that's too large/varied to inject. Don't force always-true rules through probabilistic retrieval.

## What we delete

- **Event-as-memory promotion** (`captureSlackMessage` / `captureRunnerResult` → `upsertEvent`). Events become source records or nothing. (96% never recalled.)
- **The edge graph & traversal** — `tagged_as`/`mentions` hubs, edge expansion in recall, spreading activation. The embedding cloud *is* the implicit similarity structure; explicit associative edges are redundant.
- **Any O(N²) similarity-edge builder** (Engram's `similar`). Never.
- **RRF multi-channel scoring as a recall-quality play** — 0 ranking gaps; not the lever.
- **The routing-log double-write** — already fixed (PR #100) + prune migration.
- **The frequency-based deterministic `consolidate()` and the unreliable nightly LLM pass** — replaced by per-session hook-style consolidation.

## What we keep

- **Source records** — raw evidence and the input to consolidation.
- **FTS** — for keyword / exact-identifier retrieval.
- **Provenance** — as a field (`source_session`), not a graph.
- **The eval harness and the real-DB replay** (`src/memory/eval/`, committed) plus **the `recall_log` query log** (landed in Phase 0) — the gates that decide when each phase ships. The principle-retrieval probe used in the investigation was a throwaway script, **not committed**; the durable replacement is replaying real `recall_log` rows once they accumulate.

## Non-goals (the traps)

- No O(N²) edge construction, ever.
- No application-level associative graph or graph-traversal recall.
- No event flood — events are not recallable memories.
- No vectors before curation (embedding 6,720 noise events is waste; embed a clean corpus).
- No LLM call on the hot recall path (consolidation & feedback judging are offline / post-turn).

## Infrastructure & upgrade paths

A **ladder** — start at the simplest rung, climb only when a *measured* threshold is crossed.

### Embedding provider
1. **OpenAI API** (`text-embedding-3-small`) — now. Corpus embedded offline at consolidation; queries embedded on the fly (~100–200ms, accepted).
2. **Local model** — later, for privacy / offline / latency. *Constraint:* corpus and query must share the **same model/space**; a model change means re-embedding the corpus. (Lessons leave for OpenAI today — an accepted governance call; local is the privacy exit.)

### Vector search
1. **In-app brute-force cosine** — now. Exact, zero infra. Fine to **tens of thousands** of lessons (scan is ms-scale, comparable to the embed round-trip already paid).
2. **`sqlite-vec`** — SQLite-native vector storage + exact KNN. Drop-in when you want it out of app code; still exact; more headroom.
3. **ANN / HNSW** (sqlite-vec ANN, faiss, hnswlib, or a vector DB) — **only when measured query latency on the real corpus exceeds budget** (~100k+ vectors).
   - *Critical distinction:* an ANN index **is** a neighbor graph, but it is a **retrieval-acceleration index (like a B-tree), not the associative memory graph we deleted.** You never traverse or model it; it just makes "find nearest" fast. Build is incremental O(log N), not Engram's O(N²).

### Why the runway is long
**Dedup-on-write makes the corpus grow with *distinct knowledge*, not session volume.** Near-duplicates merge, so the recallable set tracks genuinely distinct principles — which plateaus. You stay on the brute-force rung far longer than raw lesson production suggests.

### Storage
SQLite single-file throughout. A dedicated vector DB is a rung you likely never need.

### Visualization (debug only)
Project embeddings to 2D/3D (UMAP / t-SNE for clusters, PCA for speed) + on-the-fly KNN for lines — computed at render time from the vectors, **not stored**, localhost only. Projection distorts (local neighborhoods meaningful, global distances not) — exploration, not a precise map. All-pairs KNN here is harmless (small corpus, offline, occasional).

## Implementation phases

Each phase ships behind the eval gates; build the next only when the prior is measured.

- **Phase 0 — measurement (PR #100):** recall-eval harness (synthetic + real-DB replay), routing-log double-write fix + prune migration, **and the measurement fixes** — `recall()` now takes `recordUsage` (eval/replay/dashboard reads pass `false`, so they no longer mutate `use_count`) and every production recall appends `{query, tags, entities, kinds, callerIntent, returnedIds}` to a `recall_log` table. *This is the gate everything else depends on:* until weeks of real `recall_log` rows exist, every principle-recovery number is unproven, so the later phases stay parked behind it.
- **Phase 1 — curation write-path:** the `lessons` table; per-session consolidation (hook discipline + capture bar so events stay source-records); lexical dedup as a bootstrap (proximity dedup arrives with Phase 3). *Gate:* memory-health signal-to-noise improves; event flood stops.
  - **The `0/7` was an injection question, not an ingestion one — resolved: inject, don't ingest.** Tracing the delivery path: the only caller of `memory_recall` is the dispatched runner agent, and it already receives junior's `.claude/agents/common/` preamble deterministically (target-repo `common/` with per-file fallback to junior's, plus the org overlay). The merge/credential/branch and operating-contract principles the `0/7` "missed" are *already* injected (`merge-workflow.md`, `core.md`, `building-philosophy.md`, `runtime-environment.md`) — recall returning them would be redundant, and a must-always-fire rule should never be gated behind a similarity score. The only genuine residual — three judgment heuristics (sync-before-concluding, categorize-before-bulk-action, trust-the-build-over-LSP) — was injected into `building-philosophy.md`. **No `CLAUDE.md`→store loader was built**: the store is reserved for the situational long tail that *accumulates from experience* via consolidation, not for pre-loading static docs.
- **Phase 2 — feedback loop:** helpful/unhelpful + post-turn judge + weight/decay forgetting. *Gate:* helpful-rate is being recorded.
- **Phase 3 — vector channel:** embed lessons (OpenAI, offline batch); parallel FTS ∥ vector retrieval + merge; proximity dedup replaces lexical. *Gate (two hard conditions):* (a) real `recall_log` replay shows a disjoint residual that lexical — including the AND→OR fallback — still misses, and (b) those residual targets actually exist as ingested memories (Phase 1). Plus p95 within budget.
- **Phase 4 — universal-rule injection:** extract always-true rules into agent instructions. *Gate:* the injected set is small and stable.
- **Phase 5 — scale infra:** sqlite-vec, then ANN, only when measured latency demands.
- **Phase 6 — debug viz:** projection dashboard, localhost.

## Memory-health report (the standing metric)

A `memory-health` output (reuses the eval harness), emitted on each consolidation run and on demand: corpus size, % never recalled, promote / forget / dedup counts, **helpful-rate**, principle-retrieval score, signal-to-noise by tag. This is the feedback loop the old system lacked — "is memory getting better?" — and the thing you regularly fetch.

## Open questions / honest caveats

- **Association payoff is unproven.** 0/7 shows principles are *unreachable*, not that reaching them *changes outcomes*. Phase 2's helpful-rate is what proves (or kills) the vector investment — build Phase 3 in earnest only if Phase 1–2 show the situational tail is wanted.
- **No relevance labels yet** — "returns results" ≠ "returns the right lesson." The feedback loop generates the labels over time.
- **Governance** — lesson text goes to OpenAI; local embeddings are the exit if that's unacceptable.
- **Injection may carry most of the value** — if the universal-rule set turns out to do the heavy lifting, the vector channel stays a small long-tail tool, not the centerpiece.
