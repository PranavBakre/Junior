# Code Index: Task Routes

Feature doc: [task-routes.md](../features/task-routes.md). A task route is a stored, ordered path through a codebase for one kind of task — entry point, order, and tooling dead ends — so a future agent does not re-pay the cost of *locating* code. New tables in the memory DB, not a new claim kind. `src/routes/` is task routes; `src/http/routes/` is HTTP request routing and unrelated.

## Source files

### Types and store
- `src/routes/types.ts` — `MAX_ROUTE_STEPS = 8` (the cap is the feature); `StepStatus` (`untouched`/`ok`/`drifted`/`moved`/`gone`/`edge-broken`/`pending`/`unknown`/`note`), `VerifiedBy`, `VerificationTier`; `TaskRouteStepInput`/`TaskRouteStepRecord`, `TaskRouteUpsert`/`TaskRouteRecord`, `RouteRecallOptions`/`RouteRecallResult`, `StepRepair`, `RouteFetchBookkeeping`.
- `src/routes/store/interface.ts` — `TaskRouteStore`: `upsertRoute`, `getRoute`, `getRouteByIdentity`, `recallRoutes`, `recordFetch`, `recordUsage`.
- `src/routes/store/sqlite.ts` — `SqliteTaskRouteStore`, the production impl. Owns the schema (`task_route`, `task_route_step`, `CREATE UNIQUE INDEX task_route_identity ON task_route (repo, feature, task_kind)`). `upsertRoute` is `INSERT … ON CONFLICT(repo, feature, task_kind) DO UPDATE` in one transaction with the step rows; `id` is never updated, so an archived row is revived in place. `recallRoutes` = SQL `WHERE` filter then brute-force cosine in TS. `recordFetch` applies counters, repairs, sha bump, and archival in one transaction. Reuses `serializeEmbedding`/`deserializeEmbedding`/`cosineSim` exported from `src/memory/sqlite.ts` so one definition of the Float32-LE BLOB layout serves both tables.
- `src/routes/store/memory.ts` — `InMemoryTaskRouteStore` for tests/dev; mirrors the identity, revive, and active-only-search semantics.
- `src/routes/store/factory.ts` — `createTaskRouteStore(dbPath = "data/memory.db")`. Same file as `MEMORY_DB_PATH`.

### Git state
- `src/routes/freshness.ts` — the ref contract that save and verify must agree on.
  - `resolveCanonicalRef(repoPath, defaultBase?)` → `{ repoPath, ref, sha }` or **null** (repo absent / ref unresolvable → every step reports `unknown`, never `ok`). Tries `origin/<defaultBase>`, then `refs/remotes/origin/HEAD`, then `origin/main`, `origin/master`.
  - `gitShowFile` / `gitFileExists` / `gitGrep` — all read the OBJECT STORE at the ref (`git show <ref>:<path>`, `git cat-file -e`, `git grep <ref>`), never the working tree, so a dirty checkout or feature branch cannot influence verification.
  - `routeDrift(ctx, verifiedSha, paths)` — one `git log --name-only <verified_sha>..<ref> -- <route paths>` yields both the commit count and the set of paths those commits touched. Unresolvable sha → `commits: null` (unknown, not zero). `describeDrift` renders `untouched` / `N commits` / `unknown`.
  - `evaluateDecay(statuses, previousBrokenFetches, repaired)` + `ROUTE_ARCHIVE_BROKEN_FETCHES = 3` — archive when a majority of anchored steps are `gone`/`edge-broken` AND no repair landed across N fetches. `unknown` never counts as broken.
  - Private `git()` helper: `Bun.spawn` per call, both pipes drained before awaiting exit.

### Anchors
- `src/routes/anchors.ts` — expensive at write, free at read. No LSP, no ctags/gtags, no daemon.
  - `declPatternCandidates(symbol, { declarationsOnly })` — declaration-keyword form, line-start definition form, key/assignment form, plus a bare-occurrence fallback for non-code markers. Every pattern is written in the intersection of POSIX ERE and JS RegExp because the same string goes to `git grep -E` and to `new RegExp`.
  - `resolveAnchorInFile(ctx, path, symbol, options)` → `ResolvedAnchor { path, line, declPattern, sigHash, blockHash }`. `sig_hash` = whitespace-collapsed declaration line; `block_hash` = brace-balanced enclosing block (or the contiguous non-blank paragraph when nothing opens a brace), trimmed and blank-stripped.
  - `resolveAnchorRepoWide(ctx, symbol, declPattern, excludePath?)` — tier 2; declaration-shaped patterns only, so a call site is never mistaken for the symbol's new home.
  - `verifyStep(ctx, step, { untouched })` → `StepVerification { ord, status, tier, verifiedBy, resolvedPath?, repair? }`. Runs the tier ladder and reports which tier answered.

### Tools
- `src/routes/tools.ts` — `routeSave`, `routeFetch`, `routeReportUsage`, and `registerTaskRouteTools(server, runtime)`. None of them calls an LLM.
- `src/mcp/slack-server.ts` — one call to `registerTaskRouteTools` at the top of `registerTools`, wired to `MEMORY_DB_PATH`, the lazy embedding provider, and `worktreeManager.getRepo(repo)` for checkout path / default base.
- `src/routes/test-fixture.ts` — TEST-ONLY: builds a real git repo with a real bare `origin`, so the git-state behaviour is exercised rather than mocked.

## Data flow

### `route_save(repo, feature, task_kind, task_desc, steps[≤8])`
1. Reject `>8` steps and empty routes.
2. `resolveCanonicalRef` for the repo (`worktreeManager` config, falling back to `process.cwd()` when Junior is itself the repo named).
3. Per step: no `path` → a pure tooling note, stored verbatim, never fingerprinted. `path` without `symbol` → existence check at the ref. `path` + `symbol` → `resolveAnchorInFile`, storing `decl_pattern` / `sig_hash` / `block_hash`.
4. Anchors that do not resolve on the ref are stored PENDING (fingerprint columns NULL) — that is how "captured from an unmerged branch" is encoded, with no extra column.
5. Embed `task_desc` (document mode), upsert on the identity, `verified_sha` = the ref's sha. `active = 0` when every anchored step is pending.
6. → `{ route_id, resolved, unresolved[], verified_sha, ref, active }`.

### `route_fetch(repo, task, feature?, task_kind?)`
1. Lookup: exact `(repo, feature, task_kind)` first (ignores `active`, so pending/archived routes can be revived), then cosine over `task_desc` filtered to repo/feature with a `SEMANTIC_MIN_COSINE = 0.35` floor (active only).
2. No canonical ref → every step `unknown`, drift `unknown`, fetch counted, streak untouched. Never `ok`.
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
8. → `{ found, route_id, …, verified_sha, ref, drift, matched_by, steps[{ ord, note, path, symbol, status, resolved_path?, verified_by, tier, expects_ref? }], confidence, repaired[], active, archived }`.

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

- `src/routes/store/sqlite.test.ts` — identity index, identity upsert (one row, one step set), archived-row revival, fetch bookkeeping, `touch_count`, cosine recall scoping, and coexistence with `SqliteMemoryStore` in one DB file.
- `src/routes/anchors.test.ts` — real git repo + bare origin: ref resolution, verification reading the ref rather than a dirty checkout, tier 0/1/2/3 outcomes, a symbol MOVED between files, `gone`, `edge-broken`, path-only, tooling notes, pending → activation on merge, path-scoped drift, unknown sha.
- `src/routes/tools.test.ts` — end-to-end save/fetch/repair/archive/usage against a real repo, the 8-step cap, semantic vs identity lookup, the `unknown` path when the repo is absent, and the no-pruning-on-touch guarantee.

## Related

- [memory-system-v3.md](memory-system-v3.md) — the shared SQLite DB, embedding provider, and archive-never-delete decay contract.
- [mcp-server.md](mcp-server.md) — where the tools are registered.
- [worktree-manager.md](worktree-manager.md) — `RepoConfig.path` / `defaultBase`, which resolve the canonical ref.
