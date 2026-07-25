# Claim dedup: move the guard into the write path

> **Status: Shipped.** The guard lives in `SqliteMemoryStore.upsertClaim`, the
> value-metadata erasure is fixed, `MEMORY_DEDUP_THRESHOLD` is configurable, the
> backfill sweep ships as `workflows/memory-dedup-sweep.workflow.md` +
> `dedup-sweep` CLI, and `memoryHealth()` reports the near-duplicate rate.
> **The 432-duplicate backfill has NOT been applied to the live corpus** — the
> sweep is dry-run by default and applying it is an operator action (see
> [Backfill](#backfill)). The problem measurements below are historical, taken
> against `data/memory.db` at commit `905621a`.
>
> Implementation notes are collected in [What shipped](#what-shipped), including
> the places the code deliberately diverges from this document.

## Problem

Semantic dedup exists, is tested, and is bypassed by most of the writers.

`consolidateSession` embeds each draft claim and drops it when it sits within
`DEFAULT_DEDUP_THRESHOLD = 0.92` cosine of an existing claim or of another draft
in the same batch (`src/memory/consolidation/consolidate.ts:24,149-150`). That
works. But the check lives in *that caller*, not in the store, and there are four
callers of `upsertClaim`. As of this document's Shipped status every row below is
deduped by the store itself; the table records the state that motivated the fix:

| Caller | Deduped? |
|---|---|
| `consolidation/consolidate.ts:168` | **yes** — 0.92 cosine gate |
| `mcp/slack-server.ts:1854` (`memory_add`) | no |
| `memory/cli.ts:65` (`add-lesson` / `add-fact`) | no |
| `memory/cli.ts:222` (`add-claim`) | no |
| `memory/migrate-v3.ts:209` (one-shot) | no — acceptable, historical |

`memory_add` derives its id with `claimIdFromText(text)`, so re-adding *byte
identical* text upserts in place. That is exact-match dedup, not semantic: a
one-word edit produces a different id and a new row.

### Measured effect

Near-duplicate rate across the 2621 embedded claims (all pairs, cosine over the
full 640-dim vectors):

| Threshold | Claims with a twin |
|---|---|
| ≥ 0.95 | 0 (0.0%) |
| ≥ 0.92 *(the gate)* | small |
| ≥ 0.90 | 432 (16.5%) |
| ≥ 0.85 | 769 (29.3%) |

The closest surviving pair is **0.9425** — above the gate, so it cannot have
arrived through consolidation. The two texts differ by one word:

```
A: `command <tool>` is the escape hatch when a wrapper alias/hook is silently rewriting your invocation
B: `command <tool>` is the escape hatch when a wrapper alias/hook is rewriting your invocation
```

Corpus growth, for context: 2631 active claims in a **60-day-old** corpus, 765 of
them added in the last 7 days (~109/day, accelerating). [Memory v3
§6.2](memory-system-v3.md) assumes "dedup-on-write keeps it at *distinct-knowledge*
size, so it plateaus in the low thousands." No plateau is visible yet.

### Why this is a recall-quality bug before it is a storage bug

With ~30% of claims carrying a near-twin at 0.85, a `limit: 5` recall returns
fewer than five *distinct* ideas. Observed live while checking for duplicates
before adding a lesson: six results came back, five of which were paraphrases of
one "audit scope before documentation work" lesson. Four of six slots wasted.

This is also why the fix is not a vector index. Scan latency is 12.2ms p50 at this
corpus size, of which only ~3ms is cosine — well inside [§6.2's](memory-system-v3.md)
rung-1 budget. A faster index would return the redundant results faster.

### Why the gap is invisible

`consolidation/consolidate.test.ts:269` — *"dedups near-identical claim drafts and
claims near an existing stored claim"* — passes. A green test on the one guarded
path is exactly what makes the three unguarded paths read as covered. Worth a
comment on that test when the guard moves, so the next reader does not draw the
same inference. *(Shipped: that comment is on the test now, pointing at the
`claim write guard` block in `sqlite.test.ts`.)*

## Shape of the fix

### Guard at the chokepoint

Move the similarity check to where every writer already funnels: the store's
claim-write path. Two of the three ungated call sites embed the text immediately
before calling `upsertClaim` (`slack-server.ts:1851`, `cli.ts:64`), so the vector
the guard needs is already in hand.

#### A vector must exist for the guard to run

`cli.ts:222` (`add-claim`) is the exception: `--embedding` is optional and the
call writes `embedding: embedding ? new Float32Array(embedding) : null`. A
cosine guard has nothing to compare for those rows, and the store **cannot embed
its way out** — memory v3 is explicit that the store never embeds, callers embed
at the boundary (`recallMemory`'s contract, `slack-server.ts:1764-1767`).

So the invariant has to be enforced at the type/CLI level, not inferred:

- An ordinary claim insert **requires** a non-null `embedding`. `upsertClaim`
  rejects an insert that has neither an embedding nor an explicit bypass, rather
  than silently storing an unguardable, unrecallable row. (A claim with no
  embedding is already invisible to cosine-only recall — the guard gap and the
  recall gap are the same defect.)
- `add-claim` without `--embedding` either embeds via the provider before
  calling the store, or fails with a message naming `--skip-dedup`.

#### Existing-id writes need patch semantics, not a free pass

An earlier draft of this document said an existing id "must always write through,
regardless of its neighbours". That is wrong twice over.

**It erases value metadata.** `ON CONFLICT(id) DO UPDATE` sets
`helpful_count = excluded.helpful_count`, `unhelpful_count = excluded.…`, and
`weight = excluded.weight` (`sqlite.ts:183-185`), while those fields are optional
on `ClaimInput` and default to `0`/`1.0` (`sqlite.ts:201`). Any caller that
re-writes a claim by id without restating them — `add-lesson` and `memory_add`
both do — **silently resets accumulated weight to 1.0 and both counters to zero**.
That is a live defect today, independent of dedup, and it destroys exactly the
value signal the merge path below is meant to accumulate. Fix it in the same
change: update only the columns the caller actually supplied, using
`COALESCE(excluded.col, claim.col)` semantics for the value fields.

**It can still create a duplicate.** An update whose *text* changed materially is
a new claim wearing an old id, and it can land inside the threshold of a
different existing claim. Re-run the neighbour scan on any update where the text
changed, excluding the row's own id from the candidate set.

**And when that re-scan merges, the updated row must not be left behind.** The
caller has just replaced that row's text, so nobody asserts the old text any
more — but the row is still `active = 1` and still competing in recall, and no
later write can repair it, because every subsequent edit of that id re-merges the
same way and never rewrites it. Fold it into the survivor instead, with the same
semantics as the backfill sweep: counters into the survivor, then `active = 0`.
Reached through the ordinary "correct a lesson" workflow, so this is the common
case, not an edge one.

#### Bypass for restore paths

`migrate-v3.ts` and any future backup restore must write historical rows
verbatim: a `skipDedup?: boolean` on `ClaimInput`, set only by those callers, and
the same flag waives the embedding requirement above.

#### Scope and winner selection

The candidate scan is not "the whole corpus". Merging across scopes changes what
other sessions can recall, so compatibility is part of the invariant:

- **Kind:** same `kind` only, matching the cut list below.
- **Repo:** a claim merges only into a claim with the *same* `repo` value.
  Never merge a repo-specific claim into a global (`repo IS NULL`) one — that
  would leak a repo's convention into every other repo's recall — and never merge
  a global claim down into a repo-specific one, which would narrow knowledge that
  currently applies everywhere. Cross-scope near-duplicates are reported, not
  merged.

When several neighbours exceed the threshold, the winner is deterministic:
highest `weight`, then oldest `created_at`, then lowest `id`. Ties resolved any
other way make the outcome depend on row order, which makes the sweep
non-reproducible.

The scan and the merge run in **one transaction**, so a concurrent writer cannot
insert a near-duplicate between the check and the write.

That transaction must be `IMMEDIATE`. Before the guard, `upsertClaim` opened with
an INSERT; now it reads (the id lookup, then the full corpus scan — ~10ms at
2600 claims) before its first write. Under WAL a `DEFERRED` transaction takes its
read snapshot at that first SELECT, and if another connection commits inside the
window the eventual write fails with `SQLITE_BUSY_SNAPSHOT` — an error a busy
handler is specifically *not* allowed to retry, so a busy timeout alone does not
rescue it. `data/memory.db` genuinely has more than one writer: the in-process
consolidation sweep, plus any `bun run src/memory/cli.ts add-lesson` a workflow
shells out ([dynamic workflows](dynamic-workflows.md)). Measured, default
`busy_timeout = 0`:

```
deferred:  FAILED -> database is locked   (SQLITE_BUSY_SNAPSHOT)
immediate: concurrent writer blocked      ; own write succeeded
```

Taking the write lock up front turns the failure into ordinary contention, which
`PRAGMA busy_timeout` then absorbs — so both changes are needed, not either.

Two caveats worth writing down:

- **The busy timeout is a property of `SqliteMemoryStore`'s connection, not of the
  database file.** Anything that opens `data/memory.db` with its own handle —
  `migrate-v3.ts`, the routing-log migration — still runs at SQLite's default of
  0. Both are operator-run with the bot stopped, so they do not contend today; a
  future handle that runs *alongside* the bot has to set its own.
- **`IMMEDIATE` means the corpus scan now happens while holding the write lock**,
  so writes serialize on it: O(n) in corpus size, ~10ms at 2600 claims. At the
  ~109 claims/day this document measures that is ~150ms of exclusive lock per
  write within a year, which is no longer negligible. Revisit when the scan
  exceeds **~100ms** — the fix is to narrow the candidate set (rung 2 of
  [§6.2's](memory-system-v3.md) ladder), not to loosen the transaction.

### Merge, don't drop

Consolidation currently *skips* a near-duplicate draft. Silently discarding it
loses a real signal: the same claim being independently derived twice is evidence
it matters. On a near-duplicate hit, bump the surviving claim instead —
`helpful_count` and `weight`, and refresh `last_used_at`. That is the value
signal the decay contract is written against (`archiveStaleClaims` is "stale
**and** low-value"), so rediscovery accumulates evidence instead of being a
no-op. Note what that sentence does *not* say: see
[the decay wiring gap](#the-decay-half-is-not-wired-up) — nothing calls
`archiveStaleClaims` today, so this feeds a contract with no reader yet.

**The weight bump needs a ceiling.** A merge writes no row for the twin, so the
same input text merges again on every call — the bump is not idempotent by
construction. `recallClaims` scores `cosine * weight`, so a Stop hook or an agent
re-asserting one lesson each session would add +0.1 per session with no bound:
after ~40 sessions that claim outranks a cosine-0.9 match at cosine 0.2. That is
a live recall-ranking defect on its own; it does not need the decay argument to
justify a fix, and it must not be justified by one, because **nothing ever
lowers a weight again** (below). Clamp the merged weight
(`CLAIM_MERGE_WEIGHT_CEILING = 2.0` — a rediscovered claim may outrank a fresh
one of at most double its cosine, and no further) so repeated merges converge.
The clamp only holds a bump down; it never pulls an explicitly set higher weight
back. `helpful_count` stays uncapped: it feeds no ranking, and the honest count
of rediscoveries is the signal worth keeping.

#### The decay half is not wired up

Do not read the ceiling as "a safety net until decay cleans it up". Verified
against the current tree:

- **`weight` has no decrement path anywhere.** It is written in exactly three
  places — the merge bump, an explicit caller-supplied `weight`, and the insert
  default. There is no downweight-on-unhelpful and no time decay.
- **A default-weight claim is not even a fade candidate.** Inserts default to
  `weight = 1.0`; the ceiling `memoryHealth` previews fade candidates at is
  `maxWeight = 0.5`. Nothing written at the default is eligible, merged or not.
- **`archiveStaleClaims` has no caller.** It appears only in `src/memory/sqlite.ts`,
  the `MemoryStore` interface, and one test. No workflow, CLI, or scheduler
  invokes it.

So an over-weighted claim is permanent, and the ceiling is the only bound that
exists. Wiring decay up is real work and deliberately **not** part of this
branch — it is in the [cut list](#cut-list-true-v2).

The response should say which happened — `{ id, action: "inserted" | "merged",
mergedInto? }` — so a caller (and the Stop hook) can tell the difference between
"stored" and "already knew that".

### Threshold

432 claims sit in the `[0.90, 0.92)` band, immediately under the current gate.
Lowering to 0.90 is the obvious move but should not be done blind: sample that
band and judge whether the pairs are genuinely the same claim. The "audit scope"
cluster suggests they are, but a threshold that merges distinct lessons is a
worse failure than one that keeps a few twins — a merged-away claim is
recoverable only from provenance.

Make it configurable (`MEMORY_DEDUP_THRESHOLD`, default unchanged at 0.92 until
the band is sampled) so the change is a config move, not a code move.

### Cost

The guard costs one corpus scan per write: ~12ms at today's size, the same
measurement as recall. Writes are rare and off the turn's critical path, so this
is the cheap side of the pipeline to spend on — the same reasoning that puts
route fingerprinting at write time in [task routes](task-routes.md).

## Backfill

The 432 existing near-duplicates need an offline sweep, not a hot-path fix:

- Cluster claims at the chosen threshold, keep the highest-`weight` member as
  representative, sum `helpful_count` into it.
- **Archive, never delete** (`active = 0`), matching the claim decay contract —
  the collapsed rows stay as provenance.
- Ship it as a workflow under `workflows/` alongside the existing memory
  consolidation job, dry-run by default like `migrate-v3.ts`.

## Verification

Re-run the all-pairs histogram after the guard and the sweep. Success is: **no
pair above the threshold among `active = 1` claims that share a dedup scope**
(same `kind`, same `repo`), and the `[threshold-0.02, threshold)` band shrinking
rather than growing week over week.

The scoping matters — the criterion cannot be "no pair anywhere in the corpus",
because the sweep archives duplicates rather than deleting them, so their rows
(and their vectors) stay in the table by design. A global measurement would fail
permanently against its own success condition.

Add the near-duplicate rate to `memoryHealth()` so it is a standing metric
instead of a one-off measurement — without it, the next regression is as
invisible as this one was.

## What shipped

Code index: [memory-system-v3.md](../code_index/memory-system-v3.md).

| Piece | Where |
|---|---|
| The guard, the merge, the value-metadata fix | `SqliteMemoryStore.upsertClaim` + `findNearDuplicate` (`src/memory/sqlite.ts`) |
| Fold-and-archive on a merging update | `upsertClaim`'s merge branch (`collapseDuplicateClaims` semantics, inline) |
| Merge-bump ceiling | `CLAIM_MERGE_WEIGHT_BUMP` + `CLAIM_MERGE_WEIGHT_CEILING` (`src/memory/sqlite.ts`) |
| Write-lock safety | `txn.immediate()` on the two read-then-write transactions + `PRAGMA busy_timeout = 5000` |
| Scoped consolidation pre-check | `dedupScopeKey` buckets in `consolidation/consolidate.ts` |
| Shared threshold / winner ordering / scope key | `src/memory/dedup.ts` |
| Backfill sweep | `src/memory/dedup-sweep.ts`, `dedup-sweep` CLI, `workflows/memory-dedup-sweep.workflow.md` |
| Merge primitive for the sweep | `MemoryStore.collapseDuplicateClaims` |
| Near-duplicate rate | `memoryHealth()` → `MemoryHealthKind.nearDuplicates` / `.nearDuplicateRate` |
| Threshold config | `MEMORY_DEDUP_THRESHOLD` → `config.memory.dedupThreshold` → store option |

### Deliberate divergences from this document

1. **`action` has three values, not two.** The document specified
   `"inserted" | "merged"`. The code also returns `"updated"`, because this
   document's own §"Existing-id writes need patch semantics" establishes the
   existing-id write as a distinct case — reporting it as `"inserted"` would be a
   lie a caller could act on. `id` is always the row that HOLDS the knowledge
   (the survivor on a merge): on a merging INSERT the caller's id was never
   written, and on a merging UPDATE the caller's row is folded into the survivor
   and archived, so it never names a row that lost its knowledge.
2. **COALESCE preservation covers more than the three value columns.**
   `last_used_at` is included (erasing it resets the fade clock — the same decay
   signal the counters feed) and so are `embedding`/`embed_model`/`dim` (erasing
   the vector makes the row both unguardable and unrecallable, which is the
   defect this document opens with). `repo`, `tags`, `source_episode`, and
   `active` keep caller-declared `excluded.` semantics — they are scope
   declarations, not accumulated value.
3. **The re-scan trigger includes archived rows.** The document says re-scan "on
   any update where the text changed". The code also re-scans when the existing
   row is `active = 0`, because without it, re-adding a claim the backfill sweep
   archived would resurrect it one write at a time and quietly undo the sweep.

4. **An archived row is never re-folded.** A merging UPDATE folds the caller's
   row into the survivor only while that row is still `active = 1`. Re-adding a
   claim the sweep already archived takes the plain bump alone, because the sweep
   banked its counters when it collapsed it — re-folding on every re-add would
   double-count the same value signal indefinitely, which is the exact failure
   the weight ceiling above exists to prevent.
5. **The folded row keeps its own text.** It is archived, not rewritten, so the
   provenance still records what that id actually asserted. The caller's new text
   lives on in the survivor, which already held it.

Two smaller implementation choices worth naming:

- **The sweep's scheduled run is report-only.** The document says "dry-run by
  default like `migrate-v3.ts`"; the workflow therefore never passes `apply`.
  Committing a collapse is `bun run src/memory/cli.ts dedup-sweep --apply`, run
  by an operator with the bot stopped. A cron job that archives claims
  unattended would be a destructive default.
- **The near-duplicate rate is opt-out, not opt-in.** It is an all-pairs cosine
  scan (O(n²) per dedup scope, seconds at a few thousand claims — measured 1464ms
  at 2600 claims, and *synchronous*), so
  `memoryHealth({ includeNearDuplicates: false })` returns `null` counts for a
  latency-sensitive caller. It is on by default because a metric nobody asks for
  is not a standing metric. It has no production caller today; wiring it into the
  HTTP dashboard without opting out would block the event loop for the full scan,
  and there is a warning on `countNearDuplicatesByKind` saying so.
- **The rate's denominator is the EMBEDDED claims of a kind, not `total`.** Only
  a vector-carrying row can be counted as a twin, so measuring it against a corpus
  that still holds vector-less legacy rows understates the rate.

`consolidateSession` keeps its own in-batch check: the store cannot see drafts
that have not been written yet, so near-identical drafts inside one batch are
still collapsed there. Its pre-check against existing claims is now an
optimization (skip a pointless write round-trip), not the gate. Both halves of
that check are bucketed by `dedupScopeKey`, matching the store: unscoped, a
`repo: "gx-backend"` draft sitting near a *global* claim was **dropped** and
counted as `claimsDeduped` without ever reaching the store — and a drop is
strictly worse than the merge the store would have refused to make, since
cross-scope near-duplicates are supposed to be reported, not merged.

## Dependencies

- [Memory v3](memory-system-v3.md) — the claim store, `upsertClaim`, the decay
  contract this reuses, and §6.2's scan-vs-index ladder.
- [Dynamic workflows](dynamic-workflows.md) — where the backfill sweep runs.
- [MCP server](mcp-server.md) — `memory_add`, one of the ungated writers.

## Cut list (true v2)

- A vector index. Measured unnecessary at this corpus size, and orthogonal to
  the redundancy problem.
- LLM-judged duplicate detection. Cosine at a tuned threshold is cheap and
  auditable; escalate only if sampling shows the threshold cannot separate
  genuine twins from distinct claims.
- Cross-kind dedup (a `lesson` merging into a `fact`). Same-kind only until
  there is evidence the corpus needs it.
- **Wiring up decay.** `archiveStaleClaims` exists, is tested, and is called by
  nothing; `weight` has no decrement path at all
  ([above](#the-decay-half-is-not-wired-up)). Retiring stale claims and
  downweighting unhelpful ones are both real features with their own design
  questions (who schedules it, what a downweight signal even is), not a line to
  slip into a dedup branch. Naming it here so the next reader knows the gap is
  known rather than overlooked — until it lands, `CLAIM_MERGE_WEIGHT_CEILING` is
  load-bearing on its own.
