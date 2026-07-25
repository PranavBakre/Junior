# Pre-recall: synthesis placement, telemetry, and the turn-start signal

> **Status: Proposal.** The defects described are real and verified against the
> current code and logs; the fixes are not implemented. `src/memory/pre-recall.ts`
> is unchanged as of commit 0a24cdf.

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
