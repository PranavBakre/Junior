# Pre-recall: synthesis placement, telemetry, and the turn-start signal

> **Status: Shipped.** All three defects are fixed on `feat/pre-recall-synthesis`.
> The Problem section below is retained as the record of what was wrong; see
> [Implementation notes](#implementation-notes) for the shipped bounds and the
> places the implementation deliberately diverged. Code index:
> [pre-recall](../code_index/pre-recall.md).

## Problem

Pre-recall exists to keep useless spam out of the working agent's context and to
merge several recalled claims into something usable. It currently does neither,
and it costs 15 seconds of dead air per turn when it fails.

Three separate defects, each small and independently fixable.

### 1. The LLM is on the wrong end of the pipeline

`createPreRecall` (`src/memory/pre-recall.ts:72`) spends its one LLM call on
**query extraction** from the inbound Slack message, then recalls top-3 per query,
dedupes by claim id, and emits `- ${claim.text}` lines verbatim into a
`<pre-recall>` block (lines 112-140). That is a dedupe-and-list. There is no merge
and no summarization anywhere in the file — `extractRecallQueries` is the only
model call.

So the budget is spent on the unbounded half. An arbitrary Slack message has no
ceiling on complexity, which is why a 15s timeout is unsizeable; and on expiry the
function returns `null`, so the turn gets **zero** memory. Synthesis is the bounded
half: N retrieved claims of known size, a predictable prompt, and a meaningful
partial result to fall back to.

### 2. There is no denominator

`pre-recall.ts` contains exactly one log call — a `_log.warn` inside the catch
(line 144). Success is silent. The logs therefore show:

```
2026-07-24   28 timeouts
2026-07-23   61
2026-07-22   33
                  186 total across all retained logs
```

with per-day totals identical to per-day `pre-recall` line counts, which *reads*
as a 100% failure rate and is not evidence of one. Nobody can currently tell
whether pre-recall is broken or merely degraded, and no threshold change is
measurable. Fix the telemetry before tuning the number.

### 3. The dead air is invisible

The call site is a blocking `await` immediately before the runner spawns
(`src/session/manager.ts:1932-1941`). A timeout is 15 seconds during which the
thread shows nothing at all — indistinguishable from the bot ignoring the message.

## Shape of the fix

### Query derivation without a subprocess

Drop `extractRecallQueries`. Embed the raw message directly with the existing
provider — milliseconds, no subprocess, no timeout. Optional cheap keyword
expansion (repo name, thread agent) stays non-LLM.

This is the piece where the earlier "just embed the message" suggestion was
wrong *as a whole answer*: it gets retrieval right and drops curation. Curation
moves to the next stage, where it belongs.

### Synthesis after recall

One bounded LLM call over the retrieved claim set, producing the merged
`<pre-recall>` block:

| Outcome | Emitted |
|---|---|
| Synthesis returns | merged, deduplicated summary |
| Synthesis times out | **top-K raw claims** (today's behaviour) |
| Retrieval returns nothing | `null`, as today |

Worst case becomes strictly better than the current worst case of nothing.

> **As shipped**, the timeout row carries a relevance floor: retrieval applies
> no score threshold, so an unfiltered top-K on "thanks, that worked" would
> inject arbitrary nearest neighbours *and* mark them used. See
> [Implementation notes](#implementation-notes).

**What this does and does not fix.** It does not remove blocking latency: the
call is still a subprocess awaited before the runner spawns
(`session/manager.ts:1932-1941`), still under `PRE_RECALL_TIMEOUT_MS`. What
changes is that the budget now covers a *sizeable* input and there is something
to emit when it expires. Latency relief comes from the turn-start signal below
and from dropping the extraction subprocess, not from synthesis.

**"Bounded" has to be enforced, not assumed.** Claim text has no length ceiling
in the schema, so N claims is not a bounded prompt on its own. The synthesis
stage needs explicit caps: max candidates (start at the recall limit), max
characters per claim before truncation, and a total prompt-character ceiling
that drops the lowest-scoring candidates when exceeded. Without those three, the
"predictable timeout" argument does not hold.

Config: reuse `PRE_RECALL_TIMEOUT_MS` for the synthesis call; its meaning changes
from "extraction budget" to "synthesis budget" and it becomes affordable to raise,
because a fallback now exists.

### Usage must be recorded after synthesis, not at retrieval

`recallMemory` calls `recallClaims` without passing `recordUsage`
(`slack-server.ts:1804-1808`), so it takes the default `true` and bumps
`last_used_at` on **every candidate at retrieval time** — before anything decides
whether the claim was useful.

That is wrong today and gets worse under this design, because synthesis exists
precisely to discard most candidates. Filtered-out spam would be marked fresh on
every turn it is retrieved, and `archiveStaleClaims` ("stale **and** low-value")
would never fade it. The claims that most need to decay are the ones a filter
keeps rejecting.

So:

- Candidate retrieval passes `recordUsage: false`.
- Synthesis returns the ids of the claims that actually **contributed** to the
  emitted block.
- Only those ids get marked used, in one call after synthesis.
- On the timeout fallback, mark the top-K that were actually emitted — nothing
  else.

This makes `last_used_at` mean "this claim reached an agent's prompt", which is
what the decay contract assumes it means.

### Telemetry

Log the success path: queries derived, candidates recalled, claims after
synthesis, elapsed ms, and whether the fallback fired. One `log.info` per
pre-recall attempt makes both the rate and the value measurable. Ship this
**first** — it is three lines and everything else is unverifiable without it.

### Turn-start signal

Users need to see that a turn is being processed. Two options were considered:

- **A Slack message per turn** ("recalling…"). Rejected as the default: this is
  exactly the thread noise the lead was tuned to avoid, and it fires on every
  turn including fast ones.
- **A reaction** (chosen). The established pattern in this codebase —
  `this.onReaction?.(event, "eyes")` (`src/session/manager.ts:344`) via
  `SlackResponder.addReaction` (`src/slack/responder.ts:354`). Add on turn start,
  clear when the runner posts. Instant, zero new messages.

**Removal plumbing does not exist yet.** `SlackResponder` wraps only
`reactions.add` (`responder.ts:354-360`); there is no `removeReaction`. This
proposal needs it, plus a clear-on-every-terminal-path rule, or the thread
accumulates permanent "working" markers that are worse than no signal at all:

| Terminal path | Reaction cleared |
|---|---|
| Runner posts a response | yes |
| Runner spawn failure | yes |
| Turn timeout / hard kill | yes |
| Cancellation (`!stop`, driver interrupt) | yes |
| Response suppressed (`NO_SLACK_MESSAGE`, silent lead turn) | yes |

The suppressed-response case is the easy one to miss and the most common on lead
turns, which default to silent. Clearing belongs in the same `finally` that
already tears down the turn, not at each individual exit.

Reversible if the reaction proves too subtle: gate a message on elapsed time so
it only posts when pre-turn work exceeds ~3s and fast turns stay silent.

Wire the signal at the **turn level, not inside pre-recall**. Once synthesis is
placed correctly the pre-recall latency largely disappears, so the signal is
really about slow turns generally; wiring it into the recall path would cover
only one cause.

## Implementation notes

Shipped in `src/memory/pre-recall.ts`, `src/session/manager.ts`,
`src/slack/responder.ts`, `src/mcp/slack-server.ts`, and the memory store.

**The bounds that were left as "explicit caps" in the proposal.**

| Cap | Value | Why |
|---|---|---|
| Claims recalled per derived query | 8 | Was 3; the model now filters, so retrieval can be more generous. |
| Candidates reaching the prompt | 12 | Two derived queries can merge to 16; the merged set needs its own ceiling. |
| Characters per claim | 600 | Truncated with `…`. Claim text has no schema ceiling. |
| Total candidate characters | 6 000 | 12 × 600 = 7 200, so the ceiling is reachable and actually drops the lowest-scoring candidates. |
| Request characters in the prompt | 1 200 | The proposal capped the *claims*; the request is untrusted-length too, so it is capped as well or the prompt is still unbounded. |
| Raw claims on fallback | 3, each ≥ 0.55 **cosine** | Matches the previous per-query recall limit; the floor is new (see below). |
| Lines emitted | 5, 500 chars each | The block is injected into every turn's prompt. Applies to synthesized and fallback lines alike. |

**The fallback needs a relevance floor.** `recallClaims` is `slice(0, limit)`
over cosine × weight with no threshold, and `deriveRecallQueries` returns `[]`
only for whitespace — where the old extractor deliberately returned `[]` for
chit-chat. So a candidate set is essentially never empty. Without a floor,
"thanks, that worked" plus an unavailable subprocess emits three arbitrary
nearest neighbours as operational knowledge and marks them used, re-opening
through the fallback the exact decay pathology `recordUsage: false` closed at
retrieval. The floor applies **only** to the fallback — synthesis has a model
doing the filtering.

**The floor is on cosine, not on `score`.** `score = cosine × weight`
(`sqlite.ts`), so thresholding `score` lets a claim's *value* set its
*relevance* bar: cosine ≥ 0.50 at weight 1.0, but ≥ 0.83 at weight 0.6. That is
backwards — a low-weight, exactly-on-topic claim is what the fallback exists to
surface.

Measured against the live corpus (2636 active claims, 2626 with embeddings)
using each claim's own embedding as a probe and taking its best OTHER match — a
paraphrase-level neighbour, so a generous upper bound on any real Slack message:

| | p10 | p50 | p90 | max |
|---|---|---|---|---|
| best-match cosine | 0.645 | 0.761 | 0.911 | 0.920 |
| best-match score | 0.451 | 0.588 | 0.911 | 0.920 |

Weight is heavily bimodal — 39.2% of claims at 1.00 and 22.5% at 0.60 — so the
gap is not a tail case. Over 376 probes:

- cosine floor 0.5 → **0** lose their best match
- score floor 0.5 → **92** lose it (24.5%)
- of the 87 probes whose best match sits at weight ≤ 0.6, **76** lose it (87%)

Ranking stays on `score`, so weight still orders relevant candidates — it just
no longer decides eligibility. A null cosine (no query vector, or a claim
without an embedding) is ineligible: unmeasurable relevance is not relevance.

**Calibrate the value against the NOISE distribution, not the paraphrase one.**
The table above only bounds what a floor *costs*; by itself it would justify any
floor up to ~0.6. What sets the value is where chit-chat lands, because chit-chat
is the case the floor exists for. Measured through the production path
(`LocalEmbeddingProvider` → `recallClaims(limit 8)` → `selectSynthesisCandidates`),
best-candidate cosine for ten chit-chat probes:

```
"thanks, that worked" 0.432   "ok cool"            0.413   "lol"          0.395
"can you check this again" 0.500   "sounds good to me" 0.394  "good morning" 0.403
"hey what's up"       0.435   "thanks!"            0.453   "nice one"     0.384
"any update on this?" 0.477
```

Chit-chat spans **0.384–0.500**, so 0.50 sits *inside* the noise tail:
"can you check this again" peaks at exactly 0.500 and would be admitted,
emitting a claim and marking it used. Separation over 439 paraphrase probes:

| floor | chit-chat rejected | best matches lost |
|---|---|---|
| 0.50 | 9/10 | 0/439 |
| **0.55** | **10/10** | **1/439 (0.2%)** |
| 0.60 | 10/10 | 13/439 (3.0%) |

`FALLBACK_MIN_COSINE = 0.55` is the first value that clears all ten, at a cost of
one paraphrase match in 439.

> **Do not re-derive this from the test suite.** The unit and end-to-end tests
> use `HashingEmbeddingProvider`, which is token overlap rather than semantics:
> chit-chat is token-disjoint from the corpus and scores *exactly* 0.000, so
> every floor in (0.36, 1.0] passes them. An earlier revision of this document
> cited that 0.000 as if it were a corpus measurement and set the floor from it.
> `describe.skipIf(!RUN_LOCAL)("fallback floor …")` in `pre-recall.test.ts` is
> the test that can actually move this number — run it with
> `RUN_LOCAL_EMBED_TEST=1`. It pins the floor from both sides: chit-chat must
> emit nothing, and an on-topic paraphrase (measured `topcos=0.611`) must still
> emit.

**Model output is prompt-injection surface.** Before this change the
subprocess's output was only a search query, and every emitted line was a
verbatim corpus claim; now `notes` is free text from a model whose input quotes
a raw Slack message. Three defences:

1. The request is enclosed in a **per-call nonce delimiter**
   (`<request-a3f9>…</request-a3f9>`) and labelled untrusted in both prompts.
   Stripping a fixed `</request>` was the first attempt and is bypassable:
   `replaceAll` runs once, so `"</req</request>uest>"` reconstitutes the tag and
   puts the payload outside the block, while `</REQUEST>` and `</request >`
   never matched at all. A nonce the message has never seen cannot be forged, so
   this is immune by construction rather than by an exhaustive-escape argument.
2. **Notes are rejected unless `used` names at least one candidate.** Rejected
   notes take the fallback path, so the turn still gets verbatim claims.
3. The emitted block labels its own provenance (below).

Defence 2 is worth stating precisely, because it is easy to overclaim: it
proves an index was *named*, not that the note derives from it. The real bar is
"arbitrary text plus a valid integer". It filters the lazy case and gives the
fallback something to trigger on; it is not a guarantee of faithfulness. The
residual risk is framing rather than access — the Slack message is already in
the agent's prompt — but the block used to present model-authored text under a
header claiming it was "recalled from memory". `formatPreRecallBlock` now
labels the two paths differently: fallback lines are "recalled verbatim",
synthesized lines are "a model's summary … prefer the underlying claim when a
specific matters".

Known limitation: a claim cited in `used` is marked used even if it did not
really contribute, so a lying citation mildly refreshes that claim's decay
clock. Bounded by the shortlist (≤ 12) and strictly better than the previous
behaviour of marking every retrieved candidate.

**A malformed `notes` is a failure, not a rejection.** `{"notes":"one line"}`
coerced to `[]` would report a broken call as the deliberate "nothing applies"
outcome — invisible in the telemetry and, worse, skipping the fallback so the
turn gets no memory at all. Only an explicit `"notes": []` is a rejection.
Malformed covers three shapes, all reaching the same trap by different routes:
missing, non-array, and a non-empty array that leaves nothing usable after
filtering (`[{"text":"a"}]`, `["   "]`).

**Divergences from the proposal.**

- **Empty synthesis returns `null`, not raw claims.** The outcome table covers
  "synthesis returns" and "synthesis times out". A third case exists: synthesis
  succeeds and rejects every candidate. That is the curation this stage was
  added for, so it emits nothing and marks nothing used. Only *failure* falls
  back to raw claims — and the fallback can itself emit nothing when no
  candidate clears the relevance floor.
- **Query expansion is one extra query, not a keyword list.** The optional
  "repo name, thread agent" expansion is a single `"<repo> <agent>: <message>"`
  variant that biases the same vector, rather than separate keyword queries. The
  manager now passes `agent` alongside `repo`.
- **`recordUsage` rides on `RecallMemoryArgs`, not a pre-recall-local wrapper.**
  `recallMemory` has exactly two callers: the `memory_recall` MCP tool (genuine
  agent recall — still records) and pre-recall (now passes `false`). A new
  `MemoryStore.markClaimsUsed(ids, now)` performs the deferred bump.
- **Turn-progress reaction is `:hourglass_flowing_sand:`, not `:eyes:`.** The
  event layer already adds `:eyes:` on receipt and never removes it; reusing it
  would mean clearing the acknowledgement. The marker is ref-counted per
  message because a cold-start restart or guard continuation starts its
  replacement turn before the replaced one finishes tearing down, and because a
  dispatched agent turn can share the triggering message with the top-level one.
- **Reaction writes are serialized per message.** Add and remove are fired
  without awaiting and the web client runs them concurrently, so on a
  fast-exiting turn the remove can reach Slack first, return `no_reaction`
  (deliberately swallowed), and let the add land afterwards and stick forever
  with nothing in the logs. `SlackResponder` chains reaction writes per
  `channel:ts`; unrelated messages still run concurrently.
- **Dispatched agent turns are marked too — when the ts is real.** The gate is
  "this turn has a Slack message of its own", not "top-level":
  `handleAgentMessage` passes a real `event.ts` for `@junior reproducer …`, and
  those are typically the longest turns. But not every caller does: pipeline
  dispatch synthesizes `pipeline:<run>:<assignment>:<updatedAt>`
  (`pipelines/dispatch.ts`) and action buttons synthesize `<ts>:button:<action>`
  (`slack/action-buttons.ts`), both as identity keys rather than Slack
  timestamps. Reacting to those is an API call that can only fail — and
  `addReaction` logs failures at error level, so it would have emitted one bogus
  `reaction.add.fail` per pipeline assignment on the highest-volume dispatch
  path. `markTurnProgress` therefore requires a real ts shape (`/^\d+\.\d+$/`).
  Guarded centrally rather than at the two callers, because they use `ts`
  legitimately as a dedupe key and only the manager claims it is something Slack
  can react to — a caller-side fix would have to be repeated for every future
  dispatch path. Drains and continuations thread no ts through, so only a
  top-level turn can recover one from the session row.
- **The clear fires when the runner settles, marginally before the response
  posts.** It lives in a `finally` on `runRunnerWithAgent`, and the normal exit
  is `return this.onRunComplete(...)` — so the marker clears as the turn unwinds
  rather than after the Slack write. Making it strictly post-then-clear would
  mean `return await`, which would route `onRunComplete` failures into the
  setup-error catch and change unrelated error handling.
- **Known limitation:** a process restart mid-turn leaves the marker on the
  message. The ref-counts are in-memory only.

**Telemetry.** One `log.info` per attempt, emitted from a `finally` so no path
can skip it:

```
[pre-recall] repo=gx-backend queries=2 candidates=11 topcos=0.812 top=0.734 claims=3 fallback=false ms=4210
```

`topcos=` is the **best** cosine in the shortlist — the thresholded quantity, so
the number to look at before moving `FALLBACK_MIN_COSINE`. It is a max, not the
head of the list: the list is ordered by `score`, so a cosine-0.45/weight-1.0
candidate outranks a cosine-0.70/weight-0.6 one and reading the head would
understate relevance. `top=` is the top-ranked candidate's score, kept because
that is what orders them; the two diverging is the weight signal made visible.
Both read `-` when unmeasured, never `0`.
`err=` is appended when synthesis failed (with `fallback=true`) or the attempt
threw (with `claims=0`). The four zero-claim outcomes stay distinguishable: no
candidates (`candidates=0`), curation rejected everything (`fallback=false`, no
`err=`), fallback below the floor (`fallback=true` with `err=`), and a thrown
attempt (`topcos=-`).

## Dependencies

- [Memory v3](memory-system-v3.md) — `recallClaims`, the embedding provider, and
  the `recordUsage` contract (pre-recall is production recall and *should* record).
- [Session management](session-management.md) — the call site and the turn
  lifecycle the signal hangs off.
- [Slack event handler](slack-event-handler.md) — reaction add/remove plumbing.

## Configuration

```
PRE_RECALL_ENABLED=false        # unchanged; still opt-in
PRE_RECALL_RUNNER=claude        # now used for synthesis, not extraction
PRE_RECALL_MODEL=              # unchanged
PRE_RECALL_TIMEOUT_MS=15000    # now the synthesis budget, with a real fallback
```

## Cut list (true v2)

- Streaming the synthesized block into the prompt as it generates. The block is
  small; a bounded call plus fallback is enough.
- Per-agent synthesis prompts. One prompt until there is evidence roles need
  different framings.
- Caching synthesis by message similarity. Measure the hit rate first — with the
  telemetry above, that becomes answerable.
