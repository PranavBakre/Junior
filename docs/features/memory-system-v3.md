# Junior Memory System — Entity Profiles & Episodic Memory (v3)

> **Status:** Canonical direction. Extends and supersedes [memory-lesson-store.md](memory-lesson-store.md) (v2), which correctly narrowed memory to a *curated, embedded* store after the associative-memory machinery failed in measurement. v3 keeps that curated/embedded core and **generalizes the subject of memory**: memory is no longer only engineering lessons — Junior captures episodic experience (including affect — e.g. being called an idiot), and consolidates it into a heterogeneous set of **derivations** (person/repo profiles, lessons, situation-patterns, facts). Every structural choice here is constrained by **why the original `memory_event` system failed** (§2); v3 is the design that does not rebuild that failure with feelings attached.

## 1. TL;DR

- **Capture** raw turns as **source records / episodes** — provenance and evidence, *not* recallable memory. Episodes carry **affect** (emotion, intensity, valence, trigger, Junior's response, salience) and are **multi-subject**.
- **Consolidate** (offline) reads episodes and builds/updates **derivations** — a heterogeneous set, not just one kind: **profiles** (person, repo, project, situation) and the keyless long tail (**lessons, facts, atomic claims**).
- **Recall** (hot path) returns the **consolidated derivation** — never the raw episode stream.
- **Two retrieval modes decide everything downstream:** **keyed** memory (profiles, fetched by `entity_ref` from context — no vector) and **semantic** memory (lessons/facts/claims, reached only by cosine — embedded per atomic claim).
- **Storage follows retrieval mode:** profiles → **markdown files** (keyed, human-inspectable); claims/lessons → **SQLite rows** with text + embedding co-located; episodes → **SQLite raw log**.
- **Embed locally** (`onnx-community/harrier-oss-v1-270m-ONNX`, pure-TS in Bun): affective memory must not leave for a remote API.
- **Affect is record-and-inform, not behavior-shaping** (decided). Profiles are **Junior-internal, never surfaced verbatim** (decided).

## 2. Why `memory_event` failed (the binding constraint)

The original event system *was* the first attempt at episodic capture. The audit is unambiguous: **14,243 events, 96% never recalled once, 640/641 routing memories were generic logs.** Four structural causes — v3 must negate all four:

| Why events failed | What v3 does instead |
|---|---|
| **Indiscriminate capture** of every message / routing decision / runner output → flood | Capture is still cheap, but episodes are **source records**, and only *affect-bearing / notable* turns get the episode treatment |
| **Raw capture promoted DIRECTLY to recallable memory** | An episode is **never** a hot-path recall result. The recallable unit is the **consolidated derivation** |
| **Consolidation distilled events into nothing** higher-order (57 decisions ever, 0 supersessions) | Consolidation has a **concrete output**: profiles and claims. There is something to build |
| **No consumer** — events fed nothing | Episodes are **shared evidence** that multiple consolidators (person, repo, situation, lesson) read |

**The one-line invariant:** *the recallable memory is the consolidation, not the raw event.* Events failed because they skipped that step.

## 3. The "recall" ambiguity, resolved

"Recall" names two different operations; conflating them is what makes "episodes build derivations" sound like it contradicts "episodes aren't recallable":

- **Consolidation reads episodes** — offline, to *build/update* derivations. Episodes are its **input**.
- **Hot-path recall returns derivations** — to the live agent during a turn. Episodes are **not** returned.

So episodes are *read-by-the-consolidator* but *not-returned-by-recall*. Reading raw episodes to build something is fine and necessary; **returning** them as the recall result is exactly what drowned the old system.

## 4. The model — source records and their derivations

```text
                 ┌─────────────────────────────────────────────┐
 Slack / runner  │  source record / EPISODE  (raw, affect-tagged,
 turn  ─────────▶│  multi-subject)   — NOT recallable           │
                 └───────────────┬─────────────────────────────┘
                                 │  read by consolidators (offline)
        ┌──────────────────┬─────┴───────────┬─────────────────┐
        ▼                  ▼                 ▼                 ▼
   ╔══ KEYED ══╗     ╔══ KEYED ══╗   ╔═══════ SEMANTIC ═══════════════╗
   PERSON profile    REPO profile   LESSON · FACT · SITUATION · CLAIM
   (sketch)          (conventions)  (atomic, one claim per unit)
        │                  │                 │
   fetch by entity key     │            embed per claim
        └──────────────────┴─────────────────┘
                                 │
                                 ▼
   HOT-PATH RECALL:  context ─(entity key)─▶ profiles        (keyed, no vector)
                     query   ─(filters)─▶ scope ─(cosine)─▶  lessons/claims/...
```

**Profiles are one derivation among several — do not hardcode "person", and do not assume every derivation is a profile.** The split that matters is **how you reach it** (§4.1), not whether it's a "profile."

### 4.1 Keyed vs semantic — the axis that decides storage and embedding

| | **Keyed** | **Semantic** |
|---|---|---|
| Kinds | person / repo / project / situation **profiles** | **lessons, facts, atomic claims** |
| Reached by | a deterministic key from context (`entity_ref` — the interlocutor / cwd in front of you) | similarity only — there is no key |
| Needs a vector? | **No** — fetching by key is a primary-key lookup | **Yes** — cosine is the only way in |
| Granularity | a document (multi-facet sketch) | one atomic claim per unit |

Two rules fall out (see [[embed-atomic-claims-not-documents-keyed-vs-semantic]]):

- **Don't embed what you fetch by key.** A profile is loaded because its entity is in context; embedding its body produces a huge, diluted centroid vector that is never queried. (The *only* legit profile-level vector is a tiny one over a one-line identity string, and *only* for fuzzy entity **resolution**/dedup — not the profile body.)
- **Embed atomic claims, not documents.** A whole-profile vector averages away its facets ("what angers Pranav" and "Pranav's writing style" collapse onto the same mean) — the same reason gx-backend's `learning_chunk` chunks videos instead of embedding them whole.

## 5. Episode schema (the raw log — SQLite)

Episodes extend the existing `memory_source_record` (already has `actor_id`, `actor_kind`, `repo_name`, `thread_id`, `metadata_json`). They are **high-volume, never hand-edited → SQLite** (markdown here is the 14k-files inode-bloat problem). Affect lives in a typed sidecar so non-affective source records stay clean:

```sql
-- one row per notable, affect-bearing turn
episode (
  id            TEXT PRIMARY KEY REFERENCES memory_source_record(id),
  actor         TEXT,          -- who said/did it (entity ref, e.g. pranav:person)
  subjects_json TEXT,          -- entities this episode is ABOUT (multi-subject)
  what          TEXT,          -- the utterance / event, verbatim-ish
  emotion       TEXT,          -- label: frustration | praise | trust | ...
  intensity     REAL,          -- 0..1
  valence       REAL,          -- -1..+1  (negative ... positive)
  trigger       TEXT,          -- why it happened ("I auto-merged to main")
  response      TEXT,          -- Junior's reaction / outcome
  salience      REAL,          -- 0..1  how memorable (insults/praise score high)
  consolidated_into_json TEXT, -- which derivation ids this fed (provenance)
  created_at    INTEGER NOT NULL
)
```

Example — *"Pranav called me an idiot for bypassing the merge rules":*
`actor=pranav:person`, `subjects=[pranav:person, junior:self]`, `emotion=frustration`, `intensity=0.7`, `valence=-0.6`, `trigger="auto-merged to main, skipping dev-first"`, `response="apologized, fixed flow"`, `salience=0.85`.

## 6. Storage model — substrate by retrieval mode

The deciding axis is **how a unit is reached**, not whether it's "curated" (see [[storage-substrate-by-access-pattern-not-dogma]]). Three homes:

```
memory/                      # git-tracked — markdown IS the source of truth
  MEMORY.md                  # human index (the personal-memory pattern)
  profiles/
    people/pranav.md         # KEYED · frontmatter + prose · NOT embedded
    repos/gx-backend.md
data/
  memory.db                  # SQLite — raw log + the vector store:
                             #  • episode log          (raw, high-volume)
                             #  • lesson / fact / claim (text + embedding co-located)
                             #  • profile index         (entity_ref → path; optional)
```

| Kind | Retrieval | Source of truth | Embedded? |
|---|---|---|---|
| episode / source record | by id, bulk-scan | **SQLite** (raw log) | no |
| **profile** (person/repo/…) | **keyed** (`entity_ref` from context) | **markdown file** | no |
| **lesson / fact / claim** | **semantic** (cosine) | **SQLite row** | yes |

- **Profiles → markdown files.** Keyed and human-inspected/corrected — "show me what Junior thinks of me, let me fix it," with git history of how a judgment evolved. The filesystem alone suffices (convention path `profiles/people/<entity>.md` + folder glob to list); a SQLite `entity_ref → path` index is optional convenience. **No embedding column.**
- **Lessons/claims → SQLite rows** with text and embedding **co-located** (`{id, text, embedding, tags, weight}`). A markdown file for something you only reach by cosine is ceremony — you never navigate to it by path, and it's an atomic claim, not a browsable document.
- **Episodes → SQLite** raw log.

**This is not the cross-system-sync hazard** the `learning_chunk` lesson warns about: profiles (files) and claims (SQLite) are *different data*, neither duplicated in the other, each single-sourced. Where markdown is the source (profiles), the SQLite side is at most a **rebuildable** `entity_ref → path` index — wipe it and rebuild by walking `memory/`. Same source/derived-cache relationship as "text authoritative, embedding rebuildable."

### 6.1 Derivation shapes

**Profile** (markdown file — keyed, **not** embedded):

```markdown
---
kind: profile/person          # or profile/repo, profile/situation
entity_ref: pranav:person
role: principal / architect
comms_style: terse, pushes back hard
triggers: [scope creep, bypassing merge rules, over-narration]
praises: [sharp diagnosis, honest "I was wrong"]
evidence: [ep_20260628_a1, ep_...]
updated_at: 2026-06-28
---
Pranav is the principal… <prose sketch>
```

- **person**: `role`, `comms_style`, `values[]`, `triggers[]`, `praises[]`, `preferences[]`, `relationship_trajectory`, `sentiment_trend`.
- **repo**: `conventions[]`, `gotchas[]`, `merge_flow`, `owners[]`, `stack`, `hot_paths[]`. (Repos are first-class memory subjects — the existing-setup parity v2 lacked.)
- **situation**: `pattern`, `signals[]`, `recommended_action`.

**Lesson / fact / claim** (SQLite row — semantic, embedded):

```sql
claim (
  id         TEXT PRIMARY KEY REFERENCES memory_node(id),
  kind       TEXT,            -- lesson | fact | situation-claim
  text       TEXT NOT NULL,   -- ONE atomic claim (authoritative)
  embedding  BLOB,            -- Float32 LE; derived/rebuildable from text
  embed_model TEXT, dim INT,  -- invalidate/rebuild on model change
  repo TEXT, tags TEXT,       -- filter columns
  source_episode TEXT,        -- provenance (a field)
  helpful_count INT, unhelpful_count INT, weight REAL DEFAULT 1.0,
  created_at INT, last_used_at INT, active INT DEFAULT 1
)
```

`text` is authoritative; the `embedding` is derived and rebuildable.

### 6.2 Vector storage — stay on SQLite (the ladder)

The vector store is *only* over the `claim` corpus — not profiles (keyed), not episodes (raw log). That corpus is small and dedup-on-write keeps it at *distinct-knowledge* size, so it plateaus in the low thousands. The math kills the case for a vector DB:

- 818 claims × 640-dim × 4 B ≈ **2 MB**; 10k ≈ 25 MB.
- Brute-force cosine over that — *after* the SQL `WHERE` pre-filter narrows candidates — is **sub-ms to a few ms**.
- The query-embed round-trip (~10–30 ms) **dominates** the scan. A vector DB would optimize the part that is already free.

A dedicated vector store is premature infrastructure here, and it violates CLAUDE.md rule 11 (SQLite, single-writer, **no extra service**). Climb the ladder only on measured evidence (provider pattern, rule 13, makes each rung a swap, not a rewrite):

| Rung | When | What |
|---|---|---|
| **1 — brute-force cosine** *(now)* | up to ~tens of thousands | `embedding` BLOB + cosine in TS, after the `WHERE` filter. Zero new infra, exact. |
| **2 — `sqlite-vec`** *(gated)* | scan *measurably* exceeds budget | loadable SQLite extension (in-process, one file, **no service**, exact KNN); `bun:sqlite` loads it via `loadExtension`. |
| **3 — ANN / vector DB** *(probably never)* | 100k+ vectors with measured latency pain | not this workload. |

The only "switch" candidate that adds no service is **LanceDB** (embedded, native vectors) — rejected because it abandons the SQLite substrate that *carries over* (`source_record`, `entity`, FTS, `recall_log`, the eval harness), forcing an FTS reimplementation and a full migration to gain vectors we don't need at this scale. pgvector/Postgres is a service → non-starter for a single-process bot.

### 6.3 Migrating the existing store

The migration is mostly **deletion + one backfill**, not a lift-and-shift of the 90 MB DB. Carrying the audit-condemned piles forward *is* the failure (§2). Categorize, then:

1. **Drop the condemned (don't migrate):** `memory_event` (14,243; 96% never recalled), `edge` (42,876), `mention`, `memory_search_doc`, `candidate_rule`. Back up first (`memory.db.bak-before-*` exist; take a fresh one).
2. **Keep the spine untouched:** `memory_source_record`, `entity`, `memory_fts`, `recall_log`.
3. **`lesson` + `memory_fact` → `claim` (the one real backfill):** copy `title/body → text`, tags, weight; **batch-embed offline** (harrier-270) to populate `embedding`; **proximity-dedup-merge** in the same pass (the 818 accrued without dedup → near-duplicates; expect collapse to fewer distinct claims).
4. **Profiles + episodes: nothing to migrate** — net-new from future turns.
5. **Verify before cutover:** eval-harness / `recall_log` replay on the new `claim` store must hold or improve recall *before* flipping the runner.
6. **Vacuum** — 90 MB → a few MB once the flood is gone.

Run it as a **committed migration script, offline, against a copy** (per `no-prod-db-before-code` — never hand-edit the live DB ahead of the code). Old and new stores coexist behind the provider interface during verification.

```
migrate-v3.ts  (offline, on a copy of memory.db)
  0. cp memory.db memory.db.bak-before-v3
  1. create  claim, episode tables;  ensure profiles/ exists
  2. for each lesson + fact:
        text = title + body;  insert claim{ text, tags, weight, source_episode:null }
  3. embed all claim.text in batches (harrier-270, last-token pool, L2)  ->  claim.embedding
  4. proximity-dedup: cluster by cosine >= τ;  merge near-dups (keep highest weight, union tags)
  5. drop  memory_event, edge, mention, memory_search_doc, candidate_rule
  6. eval:  run recall_log replay on new store;  assert recall@k >= baseline
  7. VACUUM
  # cutover only after step 6 passes
```

## 7. Write path — consolidation

Offline / post-turn, applying the v2 hook discipline:

1. Read the session's episodes/source records.
2. For each **subject** entity, ask: does this materially change what we know? **Profiles dedup by `entity_ref` key** — merge/update the existing file in place, don't create a parallel one. **Claims dedup by embedding proximity** — embed the candidate, find nearest existing claim, merge if near-duplicate.
3. Update the prose sketch + structured fields (profiles) / write the atomic claim (claims); append episode ids to provenance; decay stale traits.
4. Lessons/claims keep the v2 high bar ("most sessions add nothing"). **Two write-bars coexist:** episodes capture *liberally* (notable affective moments are frequent, individually low-stakes); the **curation moves to the derivation** — dedup, decay — not to the capture gate.

A **rare high-salience episode** (a major conflict/praise) may be individually promoted to recallable, but that is **salience-gated, never the default.**

### 7.1 Last-used & decay (the forgetting driver)

Every unit carries a `last_used_at` so the system can identify memory that should **fade**. The semantics differ by kind, but the discipline is shared:

- **What "used" means:** a **claim/lesson** is "used" when it is **surfaced by a genuine production recall**; an **episode** is "used" when a **consolidation pass reads it** (its last contribution to a derivation); a **profile** when keyed-fetched during a real recall. Claims/lessons already have `last_used_at`; it must still be **added** to `episode` and to the **profile** frontmatter (`ProfileBase`) — both are tracked decay gaps (see §12 follow-ups), not yet wired.
- **The bump rule — only real recall writes it.** Bumping `last_used_at` is gated by a `recordUsage` flag (as the legacy `recall()` already does). **Eval/replay, the dashboard, and the graph-cloud projection MUST NOT bump it** — they pass `recordUsage=false` or use read-only paths (`exportClaimVectors` is read-only by design). Otherwise inspection traffic makes everything look "fresh" and the fade signal self-pollutes — the exact Phase-0 bug already fixed for legacy recall. *Gap to close: `recallClaims` currently selects `last_used_at` but never bumps it.*
- **Decay = forget by value, not age alone.** A fade candidate is **stale** (old or never `last_used_at`) **AND** low-value (decayed/unhelpful `weight`). Age alone never forgets — a rarely-needed but high-value lesson must survive. The offline consolidation / memory-health job archives candidates (`active = 0`); **never hard-delete** — keep provenance. This is a batch decision, never a hot-path TTL.
- **memory-health surfaces it:** `% never used`, oldest `last_used_at`, and the current fade-candidate set, per kind.

## 8. Read path — recall

Recall runs **two channels** and merges:

1. **Keyed fetch.** The interlocutor and workspace are *ground truth*: in a thread with Pranav, in `gx-backend` → read `profiles/people/pranav.md` and `profiles/repos/gx-backend.md` **directly by path**. No LLM phrasing, no cosine.
2. **Semantic search** over the claim store: embed the query → **filters scope** (`WHERE repo/kind/recency`) → **cosine ranks** within scope → **FTS** for the exact-identifier tail (slugs, file paths, PR numbers). (See [[junior-memory-filters-scope-vectors-rank]].)
3. **Return** the keyed profiles + the top-k claims, weighted by `weight`. Never the raw episode stream.

**Filters are the `WHERE`, vectors are the `ORDER BY`, FTS is the identifier escape hatch — and profiles skip all three, fetched by key.** Keyed retrieval is the extreme of "filters scope": the context narrows to exactly one row.

## 9. Governance & affect policy (decided)

- **Affect is record-and-inform, not behavior-shaping.** Junior stores emotion/reason and surfaces a profile *as context* ("Pranav values terse answers, dislikes scope creep"), but its behavior stays governed by its persona. Affect is **data, not a mood** that changes how it treats people. (A Friday-style affective stance is explicitly deferred behind a flag, not built in v1.)
- **Profiles are Junior-internal — never surfaced verbatim** in a thread. Injected into Junior's own context; inspectable/correctable by the operator (markdown files make this trivial).
- **Affective data must be embedded locally.** Any affective material that *does* get embedded does not leave for a remote API. This pulls the [local-embedding provider](memory-local-embeddings.md) from a "later rung" to **first-rung for this data.**

## 10. Embedding provider

**Pick: `onnx-community/harrier-oss-v1-270m-ONNX`** — local, pure-TS, in-process.

| Property | Value |
|---|---|
| Quality (MMTEB v2) | **66.5** (tops its size class; beats EmbeddingGemma-300M at 61.15) |
| Params / dim / context | 270M / **640** / 32K |
| License | **MIT** |
| Runtime | `@huggingface/transformers` (transformers.js + ONNX), runs in Bun on `onnxruntime-node` (CPU) — **no Python/MLX sidecar, no manual export** |
| RAM | `q8` ~270MB · `q4` ~140MB (well under the 1GB ceiling) |

**Implementation notes (these bite if missed):**

- **Pooling — silent-failure trap.** harrier is **decoder-only → last-token pooling**. The transformers.js `feature-extraction` *pipeline* defaults to **mean pooling**, which silently produces wrong vectors (no error, just bad recall). Use the raw `AutoModel` forward pass, take the **last token's hidden state, L2-normalize**. (Decoder = causal, only the last token has read the whole input; encoders like BERT/BGE are bidirectional, so they mean-pool — different architecture, different correct pooling.)
- **One model for corpus and query**, with correct **query-vs-document prompt templates** (Qwen3-family convention).
- **dtype:** `q8` for the claim corpus; revisit `fp16` only if a later eval shows it needs the ceiling.
- **Speed is not the deciding factor:** single short-query embed is ~10–30ms native on Apple Silicon — noise next to the LLM turn; corpus embedding is offline/batched. Backend (native vs WASM), not model choice, sets speed.

**Alternative (only if Gemma's gated license is acceptable and you want zero notes):** `EmbeddingGemma-300M` — first-class transformers.js, ~200MB, but ~5 lower MMTEB and a gated license.

**Meta-rule:** verify SOTA/benchmark claims against the **dated leaderboard (MTEB v2)**, not secondary blogs — small-embedder rankings flip within months (EmbeddingGemma led sub-500M at its Sept-2025 launch; harrier superseded it Mar 2026).

## 11. What carries over from v2 / what's new

**Carried:** source records as raw evidence; FTS for keyword/identifier lookup; provenance as a field; the eval harness + `recall_log` gate; dedup-on-write; helpful/unhelpful feedback weighting; "universal rules inject, don't retrieve."

**New in v3:** episodes with affect; the keyed/semantic split as the organizing axis; profiles (person/repo/situation) as keyed markdown derivations beside the embedded claim tail; markdown-as-source-of-truth for keyed memory; the local-first embedding mandate for affective data.

**Deleted (still):** event-as-memory promotion, the edge graph + spreading activation, any O(N²) similarity-edge builder, RRF-as-a-recall-play. **Newly dropped vs the first v3 draft:** the whole-profile embedding (profiles are keyed, not embedded).

## 12. Phasing (each behind the eval gate)

- **P0 — done:** `recall_log` + eval harness + routing-log prune (v2 Phase 0). Real recall traffic now logged (≈600 rows / 15 days at time of writing).
- **P1 — episodes + derivations (write path):** `episode` table; `profiles/` markdown files; `claim` table; consolidation builds person & repo profiles (keyed dedup) and atomic claims (proximity dedup); lessons keep their bar. *Gate:* event flood stops; derivations accumulate distinct knowledge.
- **P2 — read path + feedback:** keyed profile fetch by context; helpful/unhelpful feedback loop on claims. *Gate:* helpful-rate recorded.
- **P3 — local vector channel:** harrier-270-ONNX provider (last-token pooling, q8); embed the claim store; FTS ∥ vector merge; proximity dedup. *Gate:* `recall_log` replay shows a residual lexical misses **and** the targets exist as ingested claims; p95 within budget.
- **P4 — affect record-and-inform** surfaced into Junior's context (internal only).
- **P5 — scale infra** (sqlite-vec, then ANN) only when measured latency demands.

## 13. Open questions / honest caveats

- **Association/affect payoff is unproven.** The feedback loop's helpful-rate is what justifies (or kills) the vector and affect investment — build P3+ in earnest only if P1–P2 show the derivations are wanted.
- **Salience scoring** for episode promotion is a heuristic; tune against `recall_log`.
- **Profile drift / staleness:** decay must actually fire, or sketches calcify on first impressions.
- **Write concurrency on profile files:** consolidation is the only writer of derivations and is offline/post-turn — serialize it (single consolidator); live turns only read files and append episodes (to SQLite, which handles concurrency).
- **Behavior-shaping affect** (Friday-style stance) is deferred, not designed — revisit only after record-and-inform proves valuable and safe.
- **Governance edge:** even local, a person profile is a stored judgment about a colleague; keep it inspectable and correctable by the operator.
