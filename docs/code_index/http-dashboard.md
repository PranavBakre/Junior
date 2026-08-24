# Code Index: HTTP Dashboard

Localhost-only HTTP server for operator inspection and a bounded write surface (session continue/stop, workflow enqueue/start/stop/reload/create/edit). Off by default; enabled via `HTTP_DASHBOARD_PORT`. Binds 127.0.0.1 and intentionally has no auth; do not expose it beyond a trusted local operator environment. Mutating calls write `dashboard_audit`. Session continue/stop also post to the Slack thread. Workflow mutations post to a Slack output channel only when the definition has one — otherwise git + audit is a weaker trail than Slack `!` commands.

Spend capture (`usage_events`) and audit retention deletes are always-on: they are not gated on `HTTP_DASHBOARD_PORT`.

## Code Index

### src/http

| Symbol | File | Purpose |
|---|---|---|
| `startHttpServer(deps)` | `server.ts` | Bun.serve on 127.0.0.1:port; `matchApi` + method 405; serves `public/index.html`, `public/js/*`, and typed `public/assets/*` (including dashboard CSS) |
| `resolvePublicStaticPath(pathname)` | `server.ts` | Resolves `/js/*` and leftover `/assets/*` under `public/`; rejects `..`, `.`, empty segments, and null bytes |
| `matchApi(pathname)` / `allowedMethods(kind)` | `match-api.ts` | Nested session/workflow/pipeline paths; 405 on wrong method |
| `HttpServerDeps` | `server.ts` | `{ store, config, devServerManager, devServerQueue, repos, workflowRegistry, workflowScheduler, workflowStore, memoryStore?, profileStore?, pipelineStore, resolveSlackPermalink?, lookupSlackPermalink?, sessionManager, slackPoster, usageStore, auditStore, runbookCatalog?, projectRoot? }` |
| `handleHealth(store, config, startedAt, extras?)` | `routes/health.ts` | `GET /api/health` — uptime, session counts, agent counts, repo list, `pipeline.runtimeMode`, spend/audit today counters |
| `handleSessions(store, usageStore?)` | `routes/sessions.ts` | `GET /api/sessions` — allowlist projection + numeric pending + spend summary |
| `handleSessionDetail(store, threadId, resolveSlackPermalink?, usageStore?)` | `routes/sessions.ts` | `GET /api/sessions/:threadId` — same allowlist plus `resumeCwd`, spend, and a best-effort Slack permalink |
| `handleSessionContinue(req, threadId, deps)` | `routes/sessions.ts` | `POST /api/sessions/:threadId/continue` — attribution Slack post, then `injectDashboardContinue` |
| `handleSessionStop(threadId, deps)` | `routes/sessions.ts` | `POST /api/sessions/:threadId/stop` — `interruptThread` + `formatStopReply` Slack post |
| `dashboardActor(config)` / `CONTINUE_PROMPT_MAX` | `routes/sessions.ts` | `ADMIN_SLACK_USER_ID` or `dashboard-operator`; 8000-char prompt cap |
| `handleDevServers(manager, queue, repos)` | `routes/dev-server.ts` | `GET /api/dev-server` — per-repo state, idle TTL remaining, queue depth |
| `handleWorkflows(registry, store, scheduler, projectRoot?)` | `routes/workflows.ts` | `GET /api/workflows` — definitions, persisted state, recent runs, registry errors, live `displayStatus`, overlay/junior git probes |
| `handleWorkflowDetail(name, deps)` | `routes/workflows.ts` | `GET /api/workflows/:name` — on-disk markdown + both hashes + git + last 20 runs |
| `handleWorkflowRun` / `handleWorkflowStart` / `handleWorkflowStop` / `handleWorkflowReload` | `routes/workflows.ts` | Dashboard mutations; run uses `enqueueManualRun`, not blocking `runNow` |
| `handleWorkflowCreate` / `handleWorkflowPut` | `routes/workflows.ts` | Git-backed create (201) / edit (200); `?validate=1` dry-run |
| `handlePipelines(store, params, runId?, options?)` | `routes/pipelines.ts` | `GET /api/pipelines` and `GET /api/pipelines/:runId` — summaries hide default-kind unless `includeDefault=1` or `kind=default`; detail expands leases/outbox/gates. The polled list only reads already-cached Slack permalinks (`lookupSlackPermalink`); detail resolves through `resolveSlackPermalink` |
| `handlePipelineArtifact(store, runId, params, options?)` | `routes/pipelines.ts` | `GET /api/pipelines/:runId/artifacts?ref=` — relative-to-run-root file read, 256 KiB cap |
| `handleSpend(store, params)` | `routes/spend.ts` | `GET /api/spend` — usage `groupBy` over a host-local window (max 90 days) |
| `handleRunbooks(params, catalog?)` / `handleRunbookDetail(name, catalog?)` | `routes/runbooks.ts` | `GET /api/runbooks` and `GET /api/runbooks/:name` — registry + catalog + metrics |
| `handleAudit(store, params)` | `routes/audit.ts` | `GET /api/audit` — newest-first dashboard audit rows |
| `handleLogs(searchParams)` | `routes/logs.ts` | `GET /api/logs?date=YYYY-MM-DD` — parses daily log file (strict date regex prevents path traversal) |
| `handleProfiles(store, params)` | `routes/profiles.ts` | `GET /api/profiles` — read-only profile list/filter; never bumps `last_used_at` |
| `handleMemoryList()` | `routes/memory.ts` | `GET /api/memory` — list files under `docs/` |
| `handleMemoryRead(filePath)` | `routes/memory.ts` | `GET /api/memory/:path` — read a doc file (path-traversal guarded) |
| `handleMemoryRecall(store, params)` | `routes/memory.ts` | `GET /api/memory/recall` — semantic claim recall without recording dashboard usage; expands multi-kind / `fact_kinds` filters into scopes, then dedupes and re-ranks by comparable raw cosine/lexical evidence (never scope-local RRF scores) before applying one positive bounded global limit |
| `handleMemoryProjection(store, params?)` | `routes/memory.ts` | `GET /api/memory/projection` — 3D PCA + spread + KNN projection for the memory galaxy; memoised per claim set, `?refresh=1` rebuilds |
| `parseLimit` / `parseTimeBound` / `startOfLocalDay` | `query.ts` | Shared query parsing (host-local day bounds) |
| `resumeCmd(provider, sessionId, resumeCwd)` | `public/js/threads.js` | Renders provider-correct Claude, OpenCode, or Codex resume commands from detail `resumeCwd`. Continue/stop composer lives in the same module. |
| `projectClaims(claims, k?, spread?)` | `projection.ts` | PCA to 3D (power iteration + deflation) → separation relaxation → cosine KNN edges |

### src/http/audit

| Symbol | File | Purpose |
|---|---|---|
| `DashboardAuditStore` | `audit/interface.ts` | `record` / `list` / `count` / `deleteOlderThan` |
| `SqliteDashboardAuditStore` | `audit/sqlite.ts` | `dashboard_audit` in `SESSION_DB_PATH` |
| `InMemoryDashboardAuditStore` | `audit/memory.ts` | Tests / `SESSION_STORE=memory` |
| `createDashboardAuditStore` | `audit/factory.ts` | memory vs sqlite |

### Supporting control plane (not under `src/http`)

| Symbol | File | Purpose |
|---|---|---|
| `injectDashboardContinue` / `interruptThread` | `src/session/manager.ts` | Dedicated inject (returns accepted/buffered/muted) and extracted `!stop` body |
| `toDashboardSlackEvent` | `src/session/inject.ts` | Attribution inject event; `dashboardContinue: true`; dedupe `dashboard:${threadId}:${postedTs}` |
| `resolveContinueRoute` | `src/session/continue-route.ts` | `junior`/`default` → top-level default; `lead` → lead; else existing `agentSessions` row |
| `enqueueManualRun` | `src/workflows/scheduler.ts` | Await durable `persistNewRun`, void `executePersistedRun` |
| `persistNewRun` / `executePersistedRun` | `src/workflows/executor.ts` | Split so HTTP can 202 only after the run row exists |
| `writeDashboardWorkflow` / `probeWorkflowRepo` / `preflightGitRepo` | `src/workflows/git-commit.ts` | Scoped commit; refuse detached HEAD / merge / rebase; overlay parent pointer |
| `pauseReloads` / `resumeReloads` | `src/workflows/registry.ts` | Pause watcher reloads across write+commit |
| `normalizeRunnerUsage` | `src/usage/normalize.ts` | Provider blobs → one ledger row; Claude `costUsd` only |
| `sessionTurnSourceId` | `src/usage/source-id.ts` | Unique turn key with specified fallbacks |
| `UsageStore` | `src/usage/store/*` | Idempotent upsert + sum on `(source_kind, source_id)` |
| `cleanupOperationalTables` | `src/lifecycle/cleanup.ts` | Delete usage older than 90d, audit older than 180d |

## Routes

```
GET    /                       → public/index.html
GET    /api/health             → handleHealth
GET    /api/sessions           → handleSessions
GET    /api/sessions/<id>      → handleSessionDetail
POST   /api/sessions/<id>/continue → handleSessionContinue
POST   /api/sessions/<id>/stop     → handleSessionStop
GET    /api/dev-server         → handleDevServers
GET    /api/workflows          → handleWorkflows
POST   /api/workflows          → handleWorkflowCreate
GET    /api/workflows/<name>   → handleWorkflowDetail
PUT    /api/workflows/<name>   → handleWorkflowPut
POST   /api/workflows/<name>/run   → handleWorkflowRun (enqueueManualRun)
POST   /api/workflows/<name>/start → handleWorkflowStart
POST   /api/workflows/<name>/stop  → handleWorkflowStop
POST   /api/workflows/reload   → handleWorkflowReload
GET    /api/pipelines          → handlePipelines (runtimeMode + default-kind hide)
GET    /api/pipelines/<runId>  → handlePipelines (detail)
GET    /api/pipelines/<runId>/artifacts?ref= → handlePipelineArtifact
GET    /api/spend              → handleSpend
GET    /api/runbooks           → handleRunbooks
GET    /api/runbooks/<name>    → handleRunbookDetail
GET    /api/audit              → handleAudit
GET    /api/logs?date=...      → handleLogs
GET    /api/profiles[?kind=…]  → handleProfiles
GET    /api/memory             → handleMemoryList
GET    /api/memory/<path>      → handleMemoryRead
GET    /api/memory/recall      → handleMemoryRecall (503 if unavailable)
GET    /api/memory/projection  → handleMemoryProjection (503 if unavailable)
    ?refresh=1                force a rebuild instead of the memoised result
GET    /js/*                   → public/js/* (text/javascript, Cache-Control: no-cache)
GET    /assets/*               → public/assets/* (same headers; three.* stays dedicated)
GET    /assets/three.module.js → locally served pinned Three.js module
GET    /assets/three.core.min.js → locally served pinned Three.js core module
```

Wrong method on a known `/api/*` path → 405 `{ error: "method not allowed" }`.

## Frontend modules (`public/js/`)

| File | Role |
|---|---|
| `api.js` | `safeFetch`, poll, error toast |
| `app.js` | hash router, nav, overview |
| `threads.js` | list, drawer, continue/stop, `resumeCmd` |
| `pipelines.js` | default dispatch trace + pipeline list/rail + directed-flow mode selection |
| `pipeline-directed-flow-layout.js` | deterministic causal parent inference and non-overlapping left-to-right card positions |
| `pipeline-directed-flow.js` | static SVG connectors, HTML assignment cards, reply visibility, pan, zoom, reset, and frame |
| `workflows.js` | list, markdown editor, run, git status, create |
| `runbooks.js` | list + viewer |
| `spend.js` | KPI + `groupBy` table (no canvas chart) |
| `audit.js` | audit table |
| `../assets/dashboard.css` | Fresh responsive operator-console shell, shared component styling, and contained Pipeline/Memory workspaces |
| `markdown.js` | shared markdown renderer |
| `galaxy.js` | Three.js memory scene |

Pipelines default to a text-first dispatch trace with explicit run boundaries,
agent names, assignment status/timing, dispatch reason, and latest reply. The 3D
directed flow remains an optional second view. A run-start card anchors the left
edge, durable assignment cards branch to the right, solid arrows carry dispatch
reasons, and dashed return arrows represent replies. Cards expose status,
source/target agent, reason, and reply without hover. The graph is static and
supports pan, zoom, reset, and frame; it does not initialize WebGL.

## Key Concepts

### Loopback-only threat model

Binds `127.0.0.1`. No CORS headers — same-origin from `public/index.html`. Don't expose this port. No auth. Writes raise the cost of a compromised localhost tab; compensating controls are `dashboard_audit`, Slack posts for continue/stop, and optional Slack one-liners for workflows that declare an output channel. The internal MCP server is a separate loopback-only service.

### Session allowlist

List and detail share `projectSession`. Explicitly **omit**: `worktreePath`, `worktreePaths`, `cwd`, thread and per-agent `pid`, `systemPrompt`, `slackIdentity`, pending bodies, `activeTurnInput`, `activeTurnAuthor`, `activePipelineInvocation`, assignment capability envelopes. Detail-only: `resumeCwd`, `slackPermalink`. `pendingMessages` is a number.

### Continue / stop

Attribution Slack body is `*Dashboard continue*` plus a `>`-quoted preview so `containsDispatchDirective` cannot match. Event API also drops texts that start with `*Dashboard continue*`. Inject uses `dashboardContinue: true` to skip default-run hijack and short-followup. Stop reuses `interruptThread`; it does not invent a second kill path.

### Workflow enqueue vs `runNow`

`runNow` awaits the whole executor (Slack `!workflow run`). `enqueueManualRun` awaits only `persistNewRun`, then backgrounds `executePersistedRun` with `.then(schedule)` / `.catch` (failed-run status) / `.finally(releaseRun)`. HTTP 202 only after `store.getRun(runId)` would succeed. Skip-concurrency already-running is 200 `{ status: "skipped", runId: "" }`.

### Git detached-HEAD and overlay parent pointer

`writeDashboardWorkflow` / `preflightGitRepo` refuse detached HEAD, merge, rebase, and unresolved conflicts. Overlay writes preflight Junior as well, then after a successful `agents-org` commit do `git add -- agents-org` only on Junior. Parent-pointer failure does not roll back the overlay commit. Registry reloads are paused across the critical section.

### Spend and audit retention

`usage_events` 90 days, `dashboard_audit` 180 days, both swept by `cleanupOperationalTables` from the existing cleanup interval and `bun run cleanup`. Capture is inside `SessionManager` (session turns, including quiet) and once per workflow run from `SpawnResult`. For Codex app-server, the adapter retains the matching `thread/tokenUsage/updated.tokenUsage.last` snapshot until `turn/completed`, because completion payloads do not include usage.

### Path traversal guards

- Logs: `date` must match `^\d{4}-\d{2}-\d{2}$` exactly.
- Memory: rejects `..` and absolute paths; verifies resolved path stays inside `docs/`.
- Dashboard JS/assets: `resolvePublicStaticPath` rejects empty/`.`/`..` segments and null bytes, then requires the resolved path stay inside `public/`.
- Pipeline artifacts: `ref` is relative to `data/pipelines/<runId>/`; absolute paths, `..`, and strings that start with `data/pipelines/` are 400. Assignment-registered alternate roots are not readable (`resolvePipelineArtifactPath` is called without an assignment).

### Memory galaxy projection

`projection.ts` runs entirely at request time, nothing is persisted:

1. **PCA to 3D** — top-3 principal components via matrix-free power iteration plus
   deflation (never materialises the 640×640 covariance).
2. **Spread** — a separation relaxation pushes stars closer than `minSep` apart
   while KNN edges spring true neighbours back together. Local forces only, so
   PCA's global arrangement survives; a uniform spatial hash keeps it O(n) per
   iteration. Deterministic — no RNG, fixed iteration count. (A full UMAP SGD was
   tried and rejected: near-uniform cosine edge weights let attraction dominate and
   the corpus collapsed into two pinpoint balls.)
3. **KNN edges** — cosine over the FULL-dim vectors, not the projection.

Cost is O(n²·d) in the KNN, seconds on a multi-thousand-claim corpus, so the
serialized body is memoised against a count+id fingerprint of the active claim set.
`X-Projection-Cache: hit|miss` reports which path served the request.

The browser renders that projection with Three.js: claims are shader-driven
`THREE.Points`, ambient/focused KNN relationships are separate dynamic
`THREE.LineSegments`, and orbit state drives a real perspective camera. Filtering
changes GPU size/opacity attributes but never recomputes the server projection.
The canvas fills the Memory view; the DOM controls and claim rail are interaction
overlays on that single graph scene.

### Boot wiring

`index.ts` dynamic-imports `./http/server.ts` inside a try/catch — a port conflict on dashboard must not crash the bot. `UsageStore` and `DashboardAuditStore` are constructed next to the session/workflow sqlite path regardless of whether the dashboard port is set.

Both permalink deps come from one `SlackPermalinkCache` (`src/slack/permalink-cache.ts`) built at boot over `config.session.sqlitePath`. It memoizes hits in memory, persists them to the `slack_permalinks` table so a restart does not re-fetch, single-flights concurrent requests for the same message, and holds misses for 60s. `chat.getPermalink` is Tier 3, and the dashboard polls `/api/pipelines` twice every 2s — without the cache-only list lookup that alone exceeds the method's rate limit.

## Dependencies

- **Uses**: `Bun.serve`, `SessionStore`, `SessionManager` (`injectDashboardContinue`, `interruptThread`, `isAdmin`, `isExplicitAdmin`, `getSession`), Slack poster, `DevServerManager`, `DevServerQueue`, `WorkflowRegistry`, `WorkflowScheduler`, `WorkflowStore`, `PipelineStore`, `UsageStore`, `DashboardAuditStore`, optional `MemoryStore`, `ProfileStore`, and runbook `CatalogStore`, optional Slack permalink resolver, `RepoConfig`, `logger`
- **Used by**: `src/index.ts` (gated on `config.http.enabled` for the listener; usage/audit stores are always constructed)
