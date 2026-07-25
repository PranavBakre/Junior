# Task Routes

> **Status: Shipped.** `src/routes/` implements the store, anchors, git state,
> and the `route_fetch` / `route_save` / `route_report_usage` MCP tools; the
> `task_route` / `task_route_step` tables live in the memory DB. See
> [docs/code_index/task-routes.md](../code_index/task-routes.md) for the file map.
> Deliberate divergences from this design are marked **[shipped:]** inline.
> Not shipped, by design: usage-weighted pruning/promotion (gated on adoption —
> see [route_report_usage](#route_report_usage)) and the adoption wiring in
> [Adoption](#adoption).

## Problem

Agents re-pay the cost of *locating* code on every task. Reasoning is not the
expensive part; finding the entry point is.

Concrete measurement, from the session that built the dashboard memory galaxy:
before the first edit, the agent read five server files and grepped
`public/index.html` four separate times to find the CSS block, the HTML section,
the JS block, and the shared helpers — then burned three attempts discovering
that the Chrome extension was unavailable and local Playwright needed an explicit
`executablePath`. None of that is recoverable today. The next agent asked to add
a filter to that same view starts from zero.

**Who has this problem:** every dispatched agent, every pipeline stage, and the
orchestrator deciding what to hand them.
**What happens today:** ~10-15 tool calls of rediscovery per task, and tooling
dead ends are re-hit verbatim.
**"Finally" moment:** an agent asks "has anyone done this kind of task on this
feature before?" and gets back five verified steps and one "don't bother trying
X" instead of a blank page.

## What a route is — and is not

A route is an **ordered path through a codebase for one kind of task**, plus the
dead ends worth skipping. It is deliberately narrow: a route answers "where do I
start and in what order", not "what exists".

| | Owns | Example |
|---|---|---|
| `docs/code_index/<module>.md` | Exhaustive symbol → file inventory | every handler in `src/http/routes/` |
| Claims (memory v3) | Generalizable prose lessons, semantically recalled | "put the expensive step where input is bounded" |
| **Task route** | **Entry point, order, and gotchas for one task-kind on one feature** | **"adding a filter to the dashboard memory view"** |

Hard rule: **≤8 steps.** Longer than that and you have written a code index, so
write a code index and have the route point at it. A route that restates the
index is worse than no route, because two maps that disagree is worse than one
stale map.

Tooling dead ends get equal billing with file paths. "The Chrome extension is not
connected; use `node_modules/.bin/playwright` with `executablePath` pointed at
`~/Library/Caches/ms-playwright/chromium_headless_shell-*`" is pure rediscovery
cost and belongs in the route.

## Shape

```
src/routes/                     -- task routes (distinct from src/http/routes/)
├── store/
│   ├── interface.ts            -- TaskRouteStore
│   ├── factory.ts              -- createTaskRouteStore(config)
│   ├── sqlite.ts               -- SqliteTaskRouteStore (shares MEMORY_DB_PATH)
│   └── memory.ts               -- in-memory (tests)
├── anchors.ts                  -- fingerprint + verify (ripgrep only)
├── freshness.ts                -- git-scoped staleness + auto-archive rules
└── tools.ts                    -- route_fetch / route_save MCP handlers
```

> **[shipped:]** As drawn, plus `types.ts` (shared types, matching
> `src/memory/types.ts`) and `test-fixture.ts` (test-only: a real git repo with a
> real bare `origin`, because verification IS git behaviour and a fake git layer
> would prove nothing). `tools.ts` also owns `registerTaskRouteTools`, so
> `src/mcp/slack-server.ts` gains one import and one call — the same shape
> `registerWhatsAppTools` uses.

### Why not a new claim kind

The earlier proposal was a `task-route` claim kind. Reading the schema, that is
wrong on two counts:

1. A claim is **one atomic text** plus one embedding (`src/memory/types.ts`,
   `ClaimInput`). A route is structured — ordered steps, each with anchors,
   fingerprints, and usage counters. Forcing it into `claim.text` throws away
   exactly the structure the verification pass needs.
2. `claim.kind` carries a SQL `CHECK` constraint
   (`src/memory/sqlite.ts:650`). SQLite cannot `ALTER` a CHECK, so a new kind
   means a table rebuild — the codebase already carries one such migration
   (`ensureMemoryNodeAllowsClaim`) and its comment explains the cost.

New tables in the same DB need neither, and give up nothing in retrieval —
routes are searched directly, by exact key first and by an embedding on the
route's *task description* second. See [Retrieval](#retrieval--routes-are-searched-directly).

### Schema

```sql
CREATE TABLE IF NOT EXISTS task_route (
  id             TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,       -- 'junior', 'gx-backend', ...
  feature        TEXT NOT NULL,       -- 'dashboard-memory-view'
  task_kind      TEXT NOT NULL,       -- 'add-ui-surface' | 'add-endpoint' | 'debug-*'
  task_desc      TEXT NOT NULL,       -- natural language, embedded for recall
  embedding      BLOB, embed_model TEXT, dim INTEGER,
  verified_sha   TEXT NOT NULL,       -- commit the anchors were resolved against
  fetch_count    INTEGER DEFAULT 0,
  repair_count   INTEGER DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  active         INTEGER DEFAULT 1    -- archived, never deleted
);

CREATE TABLE IF NOT EXISTS task_route_step (
  route_id       TEXT NOT NULL,
  ord            INTEGER NOT NULL,
  note           TEXT NOT NULL,       -- why this step, one sentence
  path           TEXT,                -- NULL for pure tooling notes
  symbol         TEXT,                -- function/const/section-marker
  decl_pattern   TEXT,                -- regex that located the declaration
  sig_hash       TEXT,                -- hash of the declaration line
  block_hash     TEXT,                -- hash of the enclosing block
  expects_ref    TEXT,                -- "this file should still reference X"
  touch_count    INTEGER DEFAULT 0,   -- times a fetcher actually opened it
  PRIMARY KEY (route_id, ord)
);
```

```sql
CREATE UNIQUE INDEX IF NOT EXISTS task_route_identity
  ON task_route (repo, feature, task_kind);
```

> **[shipped:]** `task_route` carries one extra column, `broken_fetches INTEGER
> DEFAULT 0`. The archival rule below is "a majority of steps are gone/edge-broken
> **and** no repair has landed across N fetches", and that streak cannot be
> derived from `fetch_count` and `repair_count` alone — it needs somewhere to
> live. It resets to 0 on any repair, on any non-majority-broken fetch, and on
> every save.

That index is load-bearing, not decoration. "Unique by convention" is not an
invariant — a concurrent or interrupted `route_save` would insert a second active
route for the same identity and defeat the single-route guarantee outright. With
the constraint in place, `route_save` is a real `INSERT … ON CONFLICT(repo,
feature, task_kind) DO UPDATE` inside one transaction with its step rows, so a
save is atomic or it did not happen.

Five half-stale routes for the same task is worse than none, because the reader
cannot tell which to trust — the same discipline the lessons hook gets from
recall-before-add.

Note the interaction with archival: archived routes (`active = 0`) still occupy
the identity. Either scope the index to active rows (a partial index) or have
`route_save` revive and overwrite the archived row rather than insert alongside
it. The latter is simpler and keeps one row per identity forever.

> **[shipped:]** Revive-and-overwrite. `id` is deliberately absent from the
> `DO UPDATE` set, so the pre-existing row keeps its primary key and its step
> rows are replaced rather than orphaned. `fetch_count` and `repair_count` are
> history of the *identity* and survive an overwrite; `touch_count` does not,
> because a new step list renumbers what each `ord` means. Route ids are a
> deterministic slug of the identity, so the primary-key conflict and the
> unique-index conflict are always the same row.
>
> **The identity columns are stored slugged.** "Always the same row" only holds
> if one identity has one spelling. `route_id` lowercases and collapses every
> non-alphanumeric run, so `Memory View` and `memory-view` produced ONE id for
> TWO identities: `ON CONFLICT(repo, feature, task_kind)` did not fire, the
> INSERT hit the primary key, and the agent got a raw
> `UNIQUE constraint failed: task_route.id` back through `route_save`'s catch —
> permanently, for that spelling. An LLM caller producing `Add-UI-Surface`
> alongside `add-ui-surface` is the expected case, not an edge one. `repo`,
> `feature`, and `task_kind` are therefore normalised through the same slug on
> both write and lookup, so the second spelling overwrites the first and a fetch
> under either spelling finds the route. An identity part with nothing to slug
> (`***`) is rejected outright. The repo's *checkout* is still resolved from the
> caller's original spelling first, falling back to the slug.
>
> `InMemoryTaskRouteStore` enforces the id constraint too, raising the same
> message SQLite does. Without that it silently overwrote the clashing row,
> which is why every tool test passed against this bug.

## Anchors: expensive at write, free at read

The governing constraint is that **there is no warm language server to lean on**.
An LSP owned by the operator's VS Code is unreachable from Junior's process, and
dev servers are opt-in and unset for most pipeline runs — so any fast tier
conditioned on "a server is warm" would silently never activate.

Measured alternative (ripgrep 15.1.0, gx-backend, 5031 TS files):

| Operation | Time |
|---|---|
| Resolve one symbol's declaration repo-wide | **15ms** |
| Full declaration scan (17.5k decls, 1351 files) | 21ms |

At that cost a symbol index is a net negative: `ctags`/`gtags` add a second
source of staleness that must be rebuilt, to accelerate a lookup that was already
free. GNU global's one unique capability is a global reference index, and routes
do not need it — **a route names both ends of every edge it records**, so
"does `server.ts` still reference `handleMemoryProjection`" is a single-file grep,
not a repo-wide question. (Worth stealing from ctags without adopting it: it
anchors on a search *pattern*, not a line number. `decl_pattern` is that idea.)

So the split is:

- **`route_save` (write, no latency pressure):** resolve each symbol, record
  `decl_pattern`, `sig_hash`, `block_hash`, and stamp `verified_sha`.
- **`route_fetch` (read, hot):** compare stored fingerprints against disk. No
  index, no daemon, no warmth to check. Milliseconds.

### Verification tiers

Cheapest first; every tier is grep- or git-cost, so all of them always run.

| Tier | Check | Yields |
|---|---|---|
| 0 | path exists; `git log <verified_sha>..HEAD -- <route paths>` | `untouched` — nothing changed, route is fresh regardless of age |
| 1 | `symbol` present in `path`; `sig_hash` / `block_hash` match | `ok` / `drifted` |
| 2 | `decl_pattern` search repo-wide when tier 1 fails | `moved:<newpath>` / `gone` |
| 3 | `expects_ref` still present in the named file | `edge-broken` |

Freshness is scoped to **the route's own paths**, never wall-clock. A route
written a year ago to a module nobody has touched is perfectly good; one written
last week to a file refactored twice since is garbage. Age is not the signal;
change is.

The response reports **which tier answered each step**. `verified: fingerprint`
is stronger evidence than `verified: path-only`, and the reading agent needs that
to calibrate. This annotation is the point: an unverified route produces
confidently-wrong work with no error signal, which is the exact failure mode
[CLAUDE.md](../../CLAUDE.md) principle 1 warns about. The annotation *is* the
error signal.

> **[shipped:]** Three details the table leaves open.
>
> 1. **The searcher is `git grep <ref>`, not a `rg` subprocess.** Everything here
>    verifies against a ref, and a ref lives in git's object store — a
>    working-tree scanner cannot read it, which is precisely the property the
>    [git-state section](#which-git-state--save-and-verify-must-agree) is buying.
>    The cut-list constraint that actually mattered holds: no language server, no
>    ctags/gtags, no index, no long-lived process — one short-lived grep per call.
> 2. **Tier 0 is scoped per path, not per route.** The single
>    `git log --name-only` yields both the route-level commit count *and* the set
>    of paths touched, so one churning file does not force every sibling step out
>    of its tier-0 answer. That log runs with **`--diff-merges=first-parent`**:
>    git shows no diff for a merge commit unless one is asked for, so
>    `--name-only` prints a bare header for it and the commit is counted while
>    its paths stay invisible. This workflow is always 3-way merges and never
>    squash, so a merge carrying a conflict resolution or a build fixup is
>    ordinary — and without the flag such a step answered `untouched` /
>    `git-untouched`, the strongest label in the system, over a file the merge
>    had rewritten. Worse, it was self-concealing: every status then looked
>    clean, so `verified_sha` advanced past the merge and the next
>    `git log <newsha>..origin/main` legitimately saw nothing.
> 3. **Four extra statuses.** `note` (a pure tooling step — nothing on disk to
>    verify), `pending` (an anchor that has never resolved on the canonical ref),
>    `unknown` (repo or ref unreadable), and `untouched` as distinct from `ok`.
>    `verified_by` is reported as `git-untouched` / `fingerprint` / `path-only` /
>    `decl-pattern` / `expects-ref` / `none`, alongside the numeric tier.
>
> Tier 1 also falls back from the stored `decl_pattern` to the other
> declaration-shaped candidates for the same symbol, so a symbol that merely
> changed declaration form (`function x` → `const x = () =>`) is found in place
> instead of being reported gone. That fallback excludes the loose
> bare-occurrence pattern: after a symbol moves out of a file, the import line it
> leaves behind still mentions it, and matching that would report `drifted` in
> the old file instead of `moved` to the new one.

### Which git state — save and verify must agree

An earlier draft had `route_save` stamp "the repo HEAD" and `route_fetch` verify
against "the default worktree after a fetch". Those are two different trees, and
the mismatch breaks the design in the common case.

`route_save` fires at the end of a turn, from the Stop hook — which usually means
**an unmerged feature worktree**. Anchors resolved there may not exist on the
default branch at all, so the very first `route_fetch` would report them `gone`,
or worse, auto-repair them against whichever tree it happened to read. A `git
fetch` also does not advance a checked-out branch, so "after a fetch" does not
make a stale working copy current.

The resolution, in order of preference:

1. **One canonical ref for both operations:** `origin/<default-branch>` — the
   remote-tracking ref, which `git fetch` *does* advance, read with
   `git show <ref>:<path>` / `git grep <ref>` rather than from the working tree.
   This removes the working copy from the picture entirely, so a dirty checkout,
   a feature branch, or a half-finished rebase cannot influence verification.
2. **Save only what exists on that ref.** At `route_save`, resolve each anchor
   against `origin/<default-branch>`, not the local worktree. Anchors that
   resolve only in the unmerged branch are recorded as `pending`, and the route
   is not activated until a later fetch finds them on the canonical ref.
3. **Or defer the save.** The alternative is to run `route_save` post-merge, from
   the merge/PR path rather than the Stop hook. Cleaner semantics, weaker
   capture — the agent that knew which files mattered is long gone by then.

Option 1 plus `pending` anchors is the recommendation: it keeps capture at the
moment the knowledge exists, without letting unmerged state masquerade as
verified. `verified_sha` then means "the canonical ref this was checked against",
which is also what makes `git log <verified_sha>..<ref> -- <paths>` a meaningful
freshness query.

If the repo is not present on the box, or the canonical ref cannot be resolved,
steps report `unknown` — never `ok`.

> **[shipped:]** Option 1 plus `pending`, as recommended. A pending anchor needs
> no new column: it is a step that has `path`/`symbol` but NULL
> `decl_pattern`/`sig_hash`/`block_hash`, which is exactly "recorded but never
> resolved on the ref". `route_fetch` retries those first, before tier 0, and
> activates them for free once the work merges.
>
> "The route is not activated" is implemented as `active = 0` when EVERY anchored
> step is pending (a route with one pending step among four good ones is still
> useful, and its pending step says so). Exact-identity lookup deliberately
> ignores `active`, so a pending — or archived — route can still be revived;
> semantic search only ever returns active routes. A route of pure tooling notes
> has nothing to anchor and is active on the spot.
>
> An `unknown` fetch counts as a fetch but neither advances **nor resets** the
> broken-fetch streak: an unreadable repo is no evidence at all about the route,
> in either direction.
>
> **Something has to actually fetch.** The whole design rests on `git fetch`
> advancing the remote-tracking ref, and nothing in this feature used to do it —
> the only fetch in the system is `WorktreeManager.createWorktree`, which fires
> only when a thread creates a worktree for that repo, and never for the
> `process.cwd()` fallback. On a box that had not fetched a repo in three weeks
> every route came back `untouched` / `git-untouched` — maximum confidence —
> describing a tree nobody was working on, with nothing in the response to say
> so. Both halves of the fix ship:
>
> - `resolveCanonicalRef(..., { fetch: true })` runs a bounded
>   `git fetch origin +refs/heads/<b>:refs/remotes/origin/<b>`: SIGKILLed after
>   5s, at most once per repo+ref per `REF_FETCH_MIN_INTERVAL_MS` (10 min), and
>   best-effort — a failure just leaves the ref where it was. It touches only
>   remote-tracking refs, never the working tree or a local branch. The throttle
>   is stamped *before* the call, so an unreachable remote is not re-paid every
>   fetch. Both `route_save` and `route_fetch` ask for it.
> - `GitRefContext.committedAt` carries the ref's commit date out to
>   `route_fetch`'s `ref_committed_at`, so when the fetch does fail the reader
>   can still see how old the verified tree is.

## Tools

Both go to the **working agent**. The recall agent gets neither: which files
mattered is not inferrable from a transcript — a consolidator sees what was read
but not which reads were dead ends, and only the agent that did the work knows
the difference. Placing them here also keeps routes entirely outside the
pre-recall budget (see [pre-recall synthesis](pre-recall-synthesis.md)).

Neither tool calls an LLM. The intelligence is in the caller.

### `route_fetch`

```
route_fetch(repo, task: string, feature?: string, task_kind?: string)
  → { route_id, task_desc, verified_sha, drift: "untouched"|"N commits",
      steps: [{ ord, note, path, symbol, status, resolved_path?, verified_by }],
      confidence: { ok: n, drifted: n, moved: n, gone: n } }
```

Side effect: increments `fetch_count`, sets `last_used_at`, and auto-repairs (below).

> **[shipped:]** The response is a superset of the sketch above: it also carries
> `repo` / `feature` / `task_kind`, the `ref` verified against and its
> `ref_committed_at`, `matched_by`
> (`identity` | `semantic`), `repaired` (the ords rewritten by this fetch),
> `active`, and `archived`. `confidence` counts every status, not just the four
> named — an `edge-broken` step that vanished from the summary would defeat the
> point of reporting per-step status. Each step reports both `verified_by` and a
> numeric `tier`.
>
> A **miss** carries `known`: every `(feature, task_kind)` the repo does have,
> capped at 25. A bare "no route for this repo/feature/task-kind" leaves the
> caller guessing at the vocabulary, and guessing wrong is precisely what
> produces two spellings of one identity.

#### Retrieval — routes are searched directly

The separate table costs nothing in search capability, because the `claim` table
has no search machinery to borrow. `recallClaims`
(`src/memory/sqlite.ts:255-277`) is a SQL `WHERE` for the scalar filters, then
**cosine computed in TypeScript** over deserialized `embedding` BLOBs, sorted and
sliced. There is no vector index and no SQLite vector extension anywhere in the
schema. Any table carrying an `embedding BLOB` gets identical retrieval by
reusing roughly twenty lines. This is a deliberate, documented choice, not an
oversight — [memory v3 §6.2](memory-system-v3.md) lays out the scaling ladder and
records why LanceDB and pgvector were rejected at this corpus size.

Lookup is two-stage, most precise first:

1. **Exact** — `(repo, feature, task_kind)` when the caller knows them. This is
   the common case, because the orchestrator dispatching the task already knows
   all three.
2. **Semantic** — cosine over `task_desc` embeddings, filtered to `repo`, and to
   `feature` when given.

Scale makes the performance question moot: the corpus is one route per
`(repo, feature, task_kind)` — dozens to low hundreds — against the 2617 claims
already scanned linearly on every recall today.

> **[shipped:]** Stage 2 applies a cosine floor of 0.35 and returns at most one
> route. Below the floor the corpus has nothing for the task, and handing back
> the nearest unrelated route is worse than a blank page: the reader cannot tell
> a bad match from a stale one, and the tier annotations would all look healthy.

#### Why not reach routes *through* a claim

The alternative is a two-hop: recall a claim, have it point at a route, then read
the route. Rejected on four counts:

- **Wrong matcher.** Claim recall ranks prose by semantic similarity. Route
  lookup is primarily an exact match on three known keys. A two-hop forces the
  precise question through the fuzzy matcher and drops to the fallback path in
  the case that should have been exact.
- **A second staleness source.** The pointer-claim is one more artifact to write,
  keep in sync, and re-verify. Routes already have a decay story; the pointer
  would need its own.
- **It reintroduces the budget.** Claims are reached via pre-recall, which is
  exactly the hot path with a hard timeout that routes were placed outside of.
- **It is the spam.** A claim whose only content is "there is a route for this"
  is precisely the useless prose that pre-recall exists to filter out.

The legitimate concern buried in the two-hop idea is *discovery* — an agent that
doesn't know a route exists never calls `route_fetch`. That is an adoption
problem, solved by making the fetch a standing step 0 in the agent definitions
(see below), not by chaining retrieval through a second store.

### `route_save`

```
route_save(repo, feature, task_kind, task_desc,
           steps: [{ note, path?, symbol?, expects_ref? }])
  → { route_id, resolved: n, unresolved: [...] }
```

Resolves and fingerprints every step against `origin/<default-branch>` (see
[which git state](#which-git-state--save-and-verify-must-agree)), stamps
`verified_sha` with that ref's commit, and upserts on the unique
`(repo, feature, task_kind)` identity inside one transaction with its step rows.
Rejects >8 steps — that cap is the feature, not a limitation.

> **[shipped:]** Three things save does that the sketch does not say.
>
> 1. **Paths are made repo-relative, and absolute ones outside the checkout are
>    rejected by name.** `git show <ref>:<path>` accepts repo-relative paths
>    only, while this workspace's agent instructions mandate absolute paths
>    everywhere else — so `route_save` routinely receives
>    `/Users/…/gx-backend/src/handler.ts`. Unhandled, every such step failed to
>    resolve, was recorded `pending` with the reason "symbol not found on
>    origin/main (pending until it merges)" — entirely the wrong cause — and
>    `active` computed to `false`, leaving the route invisible to semantic
>    search forever, with the retry re-using the same bad path. A leading
>    checkout prefix is now stripped; anything still absolute gets its own
>    `unresolved` reason. A path from a *different* checkout (a sibling
>    worktree) is deliberately NOT rescued by guessing a prefix — that could
>    anchor a route to a same-named file in an unrelated repo, and a silent
>    wrong answer is worse than a loud rejection.
> 2. **`expects_ref` is resolved.** It used to be stored unchecked. The first
>    fetch masked a typo (tier 0 answers `untouched`, and the edge check is only
>    reached through tiers 0-2), then the first commit touching that file pushed
>    the step to `edge-broken` permanently — and `edge-broken` counts as broken
>    for decay, so with one anchored step that is a strict majority and the
>    route was archived after `ROUTE_ARCHIVE_BROKEN_FETCHES` fetches because of a
>    typo, not a code change. A missing edge is now its own `unresolved` reason
>    at save. It is reported, not dropped: a not-yet-merged edge is legitimate
>    and pending-shaped, and the agent is the one who can tell the difference.
> 3. **The response says it overwrote.** Last-writer-wins is the design, but
>    silently clobbering is not — the result carries `overwrote`, the previous
>    step count, and the `identity` actually written after normalisation.

### `route_report_usage`

```
route_report_usage(route_id, used_ords: number[])
  → { ok: true }
```

Explicit, because **Junior cannot observe an agent's file reads**. `route_fetch`
returns suggestions and never learns what happened next; nothing in the runner
boundary reports which paths a subagent opened. Without this call the
`touch_count` column has no writer and usage-weighted pruning is a fiction.

The caller is the agent that fetched the route, reporting at the end of its task
which steps it actually used. That is one more thing an agent must remember to
do, so the honest fallback if adoption is poor: **drop touch-based
promotion/pruning from v1** and keep only the repair/archive signals, which are
observable without cooperation. Better a smaller mechanism that works than a
counter that stays zero and quietly prunes nothing.

## Self-healing and decay

**Auto-repair.** When tier 2 resolves a moved symbol, `route_fetch` rewrites
`path`, re-fingerprints, bumps `verified_sha`, and increments `repair_count` — no
agent involvement. Ordinary refactors are the single biggest cause of map decay,
and this makes routes survive them for free. A route then only dies when the
*concept* disappears, not when the code moves.

> **[shipped:]** `verified_sha` advances only when NOTHING is left outstanding —
> every step came back `ok` / `untouched` / `moved` / `note`. Bumping it while a
> sibling step is still `drifted` would make the next fetch answer that step at
> tier 0 as `untouched` and never look at it again: one step's repair would
> silently erase another step's drift signal. Drift itself is never auto-healed;
> the content changed, so the note may now be wrong, and that is the agent's call.
>
> The same repair path activates a `pending` anchor that has since merged, which
> is why a pending step counts as a repair for the decay streak. Activation runs
> the full ladder: declaration candidates in the recorded file, then tier 2
> repo-wide, then the loose bare-occurrence form. Both orderings matter — a file
> renamed between the save and the merge used to leave the step `pending`
> forever because activation never fell through to tier 2, and putting the loose
> form last stops activation from fingerprinting the *import line* the symbol
> left behind and reporting `verified_by: fingerprint` for it. Save is
> deliberately loose (section markers and HTML ids have no declaration shape),
> but at save the agent asserted the file; at activation the pattern is
> manufactured, and the repair would persist it.

**Usage-weighted pruning** *(gated on adoption)*. Steps never reported used
across N fetches are noise and get dropped; steps consistently reported get
promoted, so the route self-prunes toward the minimum useful set instead of
growing into the inventory this design exists to avoid. This depends entirely on
agents calling [`route_report_usage`](#route_report_usage) — the signal is
*reported*, never inferred, because Junior cannot see an agent's filesystem
reads. Ship the pruning rule only once the reports are actually arriving;
until then `touch_count` stays informational and nothing is pruned on it.

> **[shipped:]** `route_report_usage` writes `touch_count` and nothing reads it.
> No pruning, no promotion, no touch-weighted aggregate — that rule stays gated
> until the reports are demonstrably arriving. A pruning rule driven by a counter
> that stays zero would quietly gut every working route.

**Archival, never deletion** — matching the claim decay contract
(`archiveStaleClaims`: archive, keep provenance). A route flips `active = 0` when
a majority of steps are `gone`/`edge-broken` **and** no repair has landed across N
fetches. That is the graceful end: it fades because it stopped being both useful
and true, not because it got old.

> **[shipped:]** N = 3 (`ROUTE_ARCHIVE_BROKEN_FETCHES`). Pure tooling notes are
> excluded from the majority count — they cannot break — and `unknown` steps
> never count as broken, so an unreadable repo can never archive a good route.
> An archived route is still reachable by exact identity and is revived by a
> `route_save` overwrite or by anchors coming back.

Do **not** collapse this to a single staleness scalar. A route 90% fresh whose
*entry point* moved is worse than one 60% fresh with a valid entry point. Report
per-step status; if an aggregate is shown, weight it by `touch_count`.

## Adoption

A tool an agent must remember to call gets called never. Two wiring changes:

- `route_fetch` becomes a standing step 0 in the orchestrator and builder agent
  definitions for any task touching a known feature area.
- `route_save` gets a Stop-hook nudge alongside the lessons hook, with a
  comparable bar: only when the task crossed ≥2 modules or hit a tooling dead end.
  Most turns still write nothing.

> **[shipped:]** NOT YET — this is the outstanding half. Both tools are
> registered on the MCP server and are callable, but neither wiring change has
> been made: no standing step 0 in the agent definitions, no Stop-hook nudge. The
> bar is carried in the tool descriptions for now, which is strictly weaker.
> Until the wiring lands, the corpus stays empty and the feature does nothing.

## Worked example

What this session would have saved, as a route:

```
repo=junior feature=dashboard-memory-view task_kind=add-ui-surface
1. public/index.html is one ~1700-line static file — CSS block, HTML sections and
   all JS in one <script>. Grep its section-marker comments; never read it whole.
2. Shared helpers at the top of the script: $, esc, safeFetch, ago, show().
   Reuse — do not redefine.
3. Server flow: route table in src/http/server.ts → handler in
   src/http/routes/<name>.ts → pure compute in src/http/projection.ts.
4. A new UI field means extending BOTH ClaimVectorExport (src/memory/types.ts)
   and exportClaimVectors (src/memory/sqlite.ts).
5. DEAD END: the Chrome extension is not connected. Verify with local Playwright,
   executablePath ~/Library/Caches/ms-playwright/chromium_headless_shell-*.
6. Page globals are script-scoped, not on window — drive them from Playwright
   with string-form page.evaluate("GAL.points.length").
```

Six lines against roughly a dozen tool calls and three failed attempts.

## Dependencies

- [Memory v3](memory-system-v3.md) — the SQLite DB (`MEMORY_DB_PATH`), the
  embedding provider reused for `task_desc`, and the archive-never-delete decay
  contract this mirrors.
- [MCP server](mcp-server.md) — where `route_fetch` / `route_save` are registered.
- [Agent definitions](agent-definitions.md) — the standing step-0 wiring.
- [Worktree manager](worktree-manager.md) — resolving a repo's default worktree
  for verification.

## Deliberate divergences from the hardening review

The five findings above were fixed as briefed except where noted here.

- **Merge attribution uses BOTH offered fixes, not one.** The brief asked to
  pick `--diff-merges=first-parent` *or* the conservative "commit header with
  zero path lines touches every scoped path" rule. Shipped: the flag first —
  it attributes the merge's edit to the exact path, so sibling steps keep their
  cheap tier-0 answer (measured: with the flag the probe prints `src/a.ts`;
  with only the conservative rule the whole scoped set is marked changed). The
  flag needs git ≥ 2.31 (this box has 2.39.5) and rather than pin a version
  floor, a failed log is retried once without it. The conservative rule then
  runs in *both* modes, so correctness never depends on the git version and any
  other shape git declines to attribute is also covered. Cost: one extra
  `git log` only when the first one fails.
- **Absolute paths from a sibling worktree are rejected, not rescued.** Only a
  literal `ctx.repoPath` prefix is stripped. Trimming leading segments until
  something resolves would silently anchor to a same-named file in another repo.
- **The bounded fetch shipped, on both tools.** `route_save` fetches too: an
  anchor resolved against a three-week-old ref is recorded `pending` when the
  code is in fact already on main.
- **A bad `expects_ref` is reported, not dropped.** Nulling it at save would
  discard a legitimately not-yet-merged edge.
- **All five minors shipped.** Pending anchors fall through to tier 2 and prefer
  declaration candidates; an `unknown` fetch writes `brokenFetches:
  route.brokenFetches`; a miss returns the repo's known identities (capped at
  25); `route_save` reports `overwrote` / `previous_steps`.
- **No data migration.** The corpus is empty — the adoption wiring below is
  still unbuilt — so nothing exists under an un-normalised spelling.
- **Still deliberately unbuilt:** the adoption wiring and usage-weighted
  pruning, unchanged from the notes in [Adoption](#adoption) and
  [Self-healing and decay](#self-healing-and-decay).

## Open questions

- **Cross-repo routes.** A bug-pipeline task spans gx-backend and gx-client-next.
  One route with a `repo` per step, or two linked routes? Leaning per-step repo.
- **Who owns `task_kind`?** A free-text field drifts into synonyms
  (`add-ui` / `add-ui-surface` / `new-ui`). Probably a small closed vocabulary
  validated at write, extended deliberately.
- **Bootstrapping.** Routes are worthless until some exist. Backfilling from
  existing `docs/code_index/*` is tempting but produces exactly the inventory-
  shaped routes this design rejects. Prefer earning them from real tasks.

## Cut list (true v2)

- LSP / ctags / gtags integration. Measured unnecessary; revisit only if a
  concrete check appears that ripgrep provably cannot answer.
- A global reference index. Routes name both endpoints.
- Any long-lived per-repo indexing process.
- Route editing UI. Auto-repair plus `route_save` overwrite is the edit path.
- Cross-agent route sharing/merging. One route per `(repo, feature, task_kind)`,
  last writer wins.
