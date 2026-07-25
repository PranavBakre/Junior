# Claim dedup: move the guard into the write path

> **Status: Proposal.** The defect is measured against the live corpus
> (`data/memory.db`, 2621 embedded claims) and the current code; the fix is not
> implemented. Measurements taken at commit `905621a`.

## Problem

Semantic dedup exists, is tested, and is bypassed by most of the writers.

`consolidateSession` embeds each draft claim and drops it when it sits within
`DEFAULT_DEDUP_THRESHOLD = 0.92` cosine of an existing claim or of another draft
in the same batch (`src/memory/consolidation/consolidate.ts:24,149-150`). That
works. But the check lives in *that caller*, not in the store, and there are four
callers of `upsertClaim`:

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
same inference.

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

### Merge, don't drop

Consolidation currently *skips* a near-duplicate draft. Silently discarding it
loses a real signal: the same claim being independently derived twice is evidence
it matters. On a near-duplicate hit, bump the surviving claim instead —
`helpful_count` and `weight`, and refresh `last_used_at`. That feeds the existing
decay contract (`archiveStaleClaims` is "stale **and** low-value"), so repeated
rediscovery makes a claim harder to fade rather than a no-op.

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
