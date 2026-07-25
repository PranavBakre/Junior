# Code Index: Task Routes

Feature doc: [task-routes.md](../features/task-routes.md). A task route is a stored, ordered path through a codebase for one kind of task — entry point, order, and tooling dead ends — so a future agent does not re-pay the cost of *locating* code. New tables in the memory DB, not a new claim kind. `src/routes/` is task routes; `src/http/routes/` is HTTP request routing and unrelated.

## Source files

### Types and store
- `src/routes/types.ts` — `MAX_ROUTE_STEPS = 8` (the cap is the feature); `StepStatus` (`untouched`/`ok`/`drifted`/`moved`/`gone`/`edge-broken`/`pending`/`unknown`/`note`), `VerifiedBy`, `VerificationTier`; `TaskRouteStepInput`/`TaskRouteStepRecord`, `TaskRouteUpsert`/`TaskRouteRecord`, `RouteIdentity`, `RouteRecallOptions`/`RouteRecallResult`, `StepRepair`, `RouteFetchBookkeeping`.
- `src/routes/store/interface.ts` — `TaskRouteStore`: `upsertRoute`, `getRoute`, `getRouteByIdentity`, `recallRoutes`, `listRouteIdentities`, `recordFetch`, `recordUsage`.
- `src/routes/store/sqlite.ts` — `SqliteTaskRouteStore`, the production impl. Owns the schema (`task_route`, `task_route_step`, `CREATE UNIQUE INDEX task_route_identity ON task_route (repo, feature, task_kind)`). `upsertRoute` is `INSERT … ON CONFLICT(repo, feature, task_kind) DO UPDATE` in one transaction with the step rows; `id` is never updated, so an archived row is revived in place. `recallRoutes` = SQL `WHERE` filter then brute-force cosine in TS. `listRouteIdentities(repo)` returns every `(feature, task_kind)` for a repo, archived included, ordered. `recordFetch` applies counters, repairs, sha bump, and archival in one transaction. Reuses `serializeEmbedding`/`deserializeEmbedding`/`cosineSim` exported from `src/memory/sqlite.ts` so one definition of the Float32-LE BLOB layout serves both tables.
- `src/routes/store/memory.ts` — `InMemoryTaskRouteStore` for tests/dev; mirrors the identity, revive, and active-only-search semantics **and the primary-key constraint on `id`**, raising the same `UNIQUE constraint failed: task_route.id` SQLite does. It previously had no id constraint, so a bug that made SQLite raise in production passed the whole tool suite.
- `src/routes/store/factory.ts` — `createTaskRouteStore(dbPath = "data/memory.db")`. Same file as `MEMORY_DB_PATH`.

### Git state
- `src/routes/freshness.ts` — the ref contract that save and verify must agree on.
  - `resolveCanonicalRef(repoPath, defaultBase?, { fetch?, now? })` → `{ repoPath, ref, sha, committedAt, fetchStatus }` or **null** (repo absent / ref unresolvable → every step reports `unknown`, never `ok`). Tries `origin/<defaultBase>`, then `refs/remotes/origin/HEAD`, then `origin/main`, `origin/master`. `committedAt` is the ref commit's ISO-8601 date and `fetchStatus` is `RefFetchStatus` (`ok`/`throttled`/`failed`/`skipped`) — both reported out so an `untouched` answer cannot pass for current when the box is weeks behind.
  - `maybeFetchRef` (private) + `REF_FETCH_MIN_INTERVAL_MS = 10min` (process-local) / `REF_FETCH_TIMEOUT_MS = 5s` / `resetRefFetchThrottle()` — nothing else in this feature fetches, so `{ fetch: true }` runs a best-effort `git fetch origin +refs/heads/<b>:refs/remotes/origin/<b>`, at most once per repo+ref per window (stamped before the call, so an unreachable remote is not re-paid). Remote-tracking refs only; never the working tree. Accepts both `origin/<b>` and `refs/remotes/origin/<b>` as the configured base — matching only the short spelling reported a perfectly fetchable ref as `skipped`. `nonInteractiveEnv(repoPath)` sets `GIT_TERMINAL_PROMPT=0` and appends `-oBatchMode=yes -oConnectTimeout=5` to `GIT_SSH_COMMAND`, **seeded from `core.sshCommand`** when the env var is unset (the env var outranks the config key, so setting it blind drops an operator's deploy key or jump host). `credential.helper` is deliberately left intact — the private https repos this fetches authenticate through it. The fetch also passes `-c http.lowSpeedLimit=1 -c http.lowSpeedTime=5` so the helper bounds itself rather than outliving the killed git for as long as the peer holds the socket.
  - `gitShowFile` / `gitFileExists` / `gitGrep` — all read the OBJECT STORE at the ref (`git show <ref>:<path>`, `git cat-file -e`, `git grep <ref>`), never the working tree, so a dirty checkout or feature branch cannot influence verification.
  - `routeDrift(ctx, verifiedSha, paths, { diffMerges? })` — one `git log --name-only --diff-merges=first-parent <verified_sha>..<ref> -- <route paths>` yields both the commit count and the set of paths those commits touched. **`--diff-merges` is load-bearing:** git shows no diff for a merge commit unless asked, so `--name-only` alone printed a bare header and a merge-carried edit was counted but never attributed — the step then answered tier-0 `untouched`/`git-untouched` over a rewritten file, and the clean fetch bumped `verified_sha` past it. On a git without the flag (< 2.31) the log is retried without it; in *both* modes a commit git listed but attributed no path to marks every scoped path changed, which costs a tier-1 fingerprint check and fails safe. Unresolvable sha → `commits: null` (unknown, not zero). `describeDrift` renders `untouched` / `N commits` / `unknown`. `{ diffMerges: false }` forces the pre-2.31 shape — the only way to reach the retry and the opaque-commit rule on a modern git, and therefore the only way to test them.
  - `evaluateDecay(statuses, previousBrokenFetches, repaired)` + `ROUTE_ARCHIVE_BROKEN_FETCHES = 3` — archive when a majority of anchored steps are `gone`/`edge-broken` AND no repair landed across N fetches. `unknown` never counts as broken.
  - Private `git()` helper, two shapes. **Untimed** (every local object-store read): pipes drained before awaiting exit, because a repo-wide grep can outrun the pipe buffer. **Timed** (only the network fetch): `stdout`/`stderr` set to `"ignore"` and the timer RACED against `proc.exited`. Killing git is not enough on its own — a helper transport spawns a separate `git-remote-https`/`ssh` that inherits the piped stderr, so the pipe stays open and a drain-then-exit read hangs indefinitely (measured 30s+ https, 25s+ ssh; only `git://` respected the kill). Optional `env` is merged over `process.env`.

### Anchors
- `src/routes/anchors.ts` — expensive at write, free at read. No LSP, no ctags/gtags, no daemon.
  - `declPatternCandidates(symbol, { declarationsOnly })` — declaration-keyword form, line-start definition form, key/assignment form, plus a bare-occurrence fallback for non-code markers. Every pattern is written in the intersection of POSIX ERE and JS RegExp because the same string goes to `git grep -E` and to `new RegExp`.
  - `resolveAnchorInFile(ctx, path, symbol, options)` → `ResolvedAnchor { path, line, declPattern, sigHash, blockHash }`. `sig_hash` = whitespace-collapsed declaration line; `block_hash` = brace-balanced enclosing block (or the contiguous non-blank paragraph when nothing opens a brace), trimmed and blank-stripped.
  - `resolveAnchorRepoWide(ctx, symbol, declPattern, excludePath?)` — tier 2; declaration-shaped patterns only, so a call site is never mistaken for the symbol's new home.
  - `verifyStep(ctx, step, { untouched })` → `StepVerification { ord, status, tier, verifiedBy, resolvedPath?, repair? }`. Runs the tier ladder and reports which tier answered. A PENDING anchor (path+symbol, no `decl_pattern`) is activated through its own ladder first: declaration candidates in the recorded file → tier 2 repo-wide (so a file renamed before the merge does not stay pending forever) → the loose bare-occurrence form last, so activation cannot fingerprint the import line the symbol left behind and call it `fingerprint` evidence.

### Tools
- `src/routes/tools.ts` — `routeSave`, `routeFetch`, `routeReportUsage`, and `registerTaskRouteTools(server, runtime)`. None of them calls an LLM.
- `src/mcp/slack-server.ts` — one call to `registerTaskRouteTools` at the top of `registerTools`, wired to `MEMORY_DB_PATH`, the lazy embedding provider, and `worktreeManager.getRepo(repo)` for checkout path / default base.
- `src/routes/test-fixture.ts` — TEST-ONLY: builds a real git repo with a real bare `origin`, so the git-state behaviour is exercised rather than mocked.

## Data flow

### `route_save(repo, feature, task_kind, task_desc, steps[≤8])`
1. Reject `>8` steps and empty routes. Normalise `repo` / `feature` / `task_kind` through `slug` (`normalizeKey`), rejecting a part with no alphanumerics — one identity, one spelling, so the deterministic `route_id` and the `ON CONFLICT` target can never disagree.
2. `resolveCanonicalRef(..., { fetch: true })` for the repo (`worktreeManager` config under the caller's spelling then the slug, falling back to `process.cwd()` when Junior is itself the repo named).
3. Per step: no `path` → a pure tooling note, stored verbatim, never fingerprinted. Otherwise `toRepoRelative` strips a leading checkout prefix; an absolute path from *another* checkout is rejected with its own `unresolved` reason rather than guessed at. `path` without `symbol` → existence check at the ref. `path` + `symbol` → `resolveAnchorInFile`, storing `decl_pattern` / `sig_hash` / `block_hash`.
4. `expects_ref` is resolved at save (one `gitShowFile` when the path is on the ref) and gets its own `unresolved` reason when missing — otherwise a typo is masked by tier 0 on the first fetch, then archives the route three fetches later as `edge-broken`.
5. Anchors that do not resolve on the ref are stored PENDING (fingerprint columns NULL) — that is how "captured from an unmerged branch" is encoded, with no extra column.
6. Embed `task_desc` (document mode), upsert on the identity, `verified_sha` = the ref's sha. `active = 0` when every anchored step is pending.
7. → `{ route_id, resolved, unresolved[], verified_sha, ref, ref_fetch, ref_committed_at, active, identity, overwrote, previous_steps? }`. On a `failed` fetch every ref-relative `unresolved` reason also carries the doubt inline — otherwise "pending until it merges" names a cause that does not exist when the truth is that this box is simply behind the remote.

### `route_fetch(repo, task, feature?, task_kind?)`
1. Lookup (identity parts slugged on the way in): exact `(repo, feature, task_kind)` first (ignores `active`, so pending/archived routes can be revived), then cosine over `task_desc` filtered to repo/feature with a `SEMANTIC_MIN_COSINE = 0.35` floor (active only). A miss returns `known` — the repo's `(feature, task_kind)` vocabulary, capped and collated **inside the store** so both implementations page identically.
2. No canonical ref → every step `unknown`, drift `unknown`, fetch counted, streak carried unchanged (neither advanced nor reset — an unreadable repo is no evidence in either direction). Never `ok`.
3. `routeDrift` once; a step whose path is not in `changedPaths` gets the tier-0 answer.
4. `verifyStep` per step through the ladder:

   | Tier | Check | Yields | `verified_by` |
   |---|---|---|---|
   | 0 | path exists at ref; nothing touched it since `verified_sha` | `untouched` | `git-untouched` |
   | 0 | path exists, step has no symbol | `ok` / `gone` | `path-only` |
   | 1 | symbol present in path; `sig_hash`/`block_hash` compared | `ok` / `drifted` | `fingerprint` |
   | 2 | `decl_pattern` resolved repo-wide when tier 1 failed | `moved` / `gone` | `decl-pattern` |
   | 3 | `expects_ref` still in the named file (downgrade only) | `edge-broken` | `expects-ref` |

5. Auto-repair: a tier-2 `moved` (or a pending anchor that now resolves) rewrites `path` + fingerprints and bumps `repair_count` — no agent involvement.
6. `verified_sha` advances only when NOTHING is left outstanding, so an unrelated repair can never erase a still-drifted step's signal.
7. Decay/activation, then one `recordFetch` transaction.
8. → `{ found, route_id, …, verified_sha, ref, ref_committed_at, ref_fetch, drift, matched_by, steps[{ ord, note, path, symbol, status, resolved_path?, verified_by, tier, expects_ref? }], confidence, repaired[], active, archived }`, or `{ found: false, repo, reason, known[] }`.

### `route_report_usage(route_id, used_ords)`
Bumps `touch_count` on the reported steps. Junior cannot observe an agent's file reads, so this is the only writer. **Informational only** — no pruning or promotion is implemented on it yet.

## Schema

```sql
CREATE TABLE task_route (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, feature TEXT NOT NULL, task_kind TEXT NOT NULL,
  task_desc TEXT NOT NULL, embedding BLOB, embed_model TEXT, dim INTEGER,
  verified_sha TEXT NOT NULL, fetch_count INTEGER DEFAULT 0, repair_count INTEGER DEFAULT 0,
  broken_fetches INTEGER DEFAULT 0, created_at INTEGER NOT NULL, last_used_at INTEGER,
  active INTEGER DEFAULT 1
);
CREATE TABLE task_route_step (
  route_id TEXT NOT NULL, ord INTEGER NOT NULL, note TEXT NOT NULL, path TEXT, symbol TEXT,
  decl_pattern TEXT, sig_hash TEXT, block_hash TEXT, expects_ref TEXT,
  touch_count INTEGER DEFAULT 0, PRIMARY KEY (route_id, ord)
);
CREATE UNIQUE INDEX task_route_identity ON task_route (repo, feature, task_kind);
```

`broken_fetches` is the one column not in the feature doc's schema: the archival rule ("no repair has landed across N fetches") has nowhere else to hold N.

## Tests

- `src/routes/store/sqlite.test.ts` — identity index, identity upsert (one row, one step set), the id constraint raising on two identities aliased to one id, `listRouteIdentities`, archived-row revival, fetch bookkeeping, `touch_count`, cosine recall scoping, and coexistence with `SqliteMemoryStore` in one DB file.
- `src/routes/store/memory.test.ts` — the same identity/id/list guarantees for `InMemoryTaskRouteStore`, which is what every tool test runs against (an invariant it does not enforce is one those tests cannot see), plus a parity case running one corpus through BOTH stores to pin the cap and the BINARY collation.
- `src/routes/anchors.test.ts` — real git repo + bare origin: ref resolution, verification reading the ref rather than a dirty checkout, tier 0/1/2/3 outcomes, a symbol MOVED between files, `gone`, `edge-broken`, path-only, tooling notes, pending → activation on merge, path-scoped drift, **a real merge commit carrying an edit** (asserting both the precise first-parent attribution — so it fails on git < 2.31 — and, via `{ diffMerges: false }`, the conservative fallback that would otherwise be untested), **a fetch against a socket that accepts and never answers** (returns inside the 5s bound; pre-fix this hung past 20s with an orphaned helper), a fully-qualified `refs/remotes/origin/main` base still fetching, a config-only `core.sshCommand` being invoked rather than clobbered (proved by a wrapper script that touches a marker), unknown sha.
- `src/routes/tools.test.ts` — end-to-end save/fetch/repair/archive/usage against a real repo, the 8-step cap, semantic vs identity lookup, the `unknown` path when the repo is absent, the no-pruning-on-touch guarantee, and one regression case per fixed finding: merge-carried drift, two spellings of one identity, absolute paths in/out of the checkout, `expects_ref` checked at save, auto-fetch of a deliberately-rewound `origin/main`, `known` on a miss, the streak surviving an unreadable repo, pending activation via tier 2 rather than an import line, and a failed fetch producing `ref_fetch: "failed"` plus a reason that does not blame an unmerged branch.
- `src/routes/test-fixture.ts` gained `merge(branch, filesInMerge?)` (a real `--no-ff` merge commit carrying edits made during the merge), `rewindOriginRef(sha)` (moves the LOCAL remote-tracking ref back without touching the bare remote — "this box has not fetched in a while"), `setRemoteUrl(url)` (point `origin` at a host that never answers), and `gitConfig(key, value)`.

## Related

- [memory-system-v3.md](memory-system-v3.md) — the shared SQLite DB, embedding provider, and archive-never-delete decay contract.
- [mcp-server.md](mcp-server.md) — where the tools are registered.
- [worktree-manager.md](worktree-manager.md) — `RepoConfig.path` / `defaultBase`, which resolve the canonical ref.
