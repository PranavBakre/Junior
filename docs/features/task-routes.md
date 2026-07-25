# Task Routes

> **Status: Proposal.** Nothing here is implemented. No `src/routes/` module,
> `task_route` table, or `route_fetch` / `route_save` tool exists yet. Measurements
> and file references are current as of commit 0a24cdf; the design is not an
> implementation contract until it ships.

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

**Usage-weighted pruning** *(gated on adoption)*. Steps never reported used
across N fetches are noise and get dropped; steps consistently reported get
promoted, so the route self-prunes toward the minimum useful set instead of
growing into the inventory this design exists to avoid. This depends entirely on
agents calling [`route_report_usage`](#route_report_usage) — the signal is
*reported*, never inferred, because Junior cannot see an agent's filesystem
reads. Ship the pruning rule only once the reports are actually arriving;
until then `touch_count` stays informational and nothing is pruned on it.

**Archival, never deletion** — matching the claim decay contract
(`archiveStaleClaims`: archive, keep provenance). A route flips `active = 0` when
a majority of steps are `gone`/`edge-broken` **and** no repair has landed across N
fetches. That is the graceful end: it fades because it stopped being both useful
and true, not because it got old.

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
