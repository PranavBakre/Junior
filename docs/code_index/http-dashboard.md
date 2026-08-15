# Code Index: HTTP Dashboard

Localhost-only HTTP server for operator inspection (sessions, dev-servers, workflows, pipelines, logs, docs, profiles, and memory projections). Off by default; enabled via `HTTP_DASHBOARD_PORT`. Binds 127.0.0.1 and intentionally has no auth; do not expose it beyond a trusted local operator environment.

## Code Index

### src/http

| Symbol | File | Purpose |
|---|---|---|
| `startHttpServer(deps)` | `server.ts` | Bun.serve on 127.0.0.1:port; routes API + serves `public/index.html` |
| `HttpServerDeps` | `server.ts` | `{ store, config, devServerManager, devServerQueue, repos, workflowRegistry, workflowScheduler, workflowStore, memoryStore?, profileStore?, pipelineStore, resolveSlackPermalink?, usageStore, auditStore, runbookCatalog? }` |
| `handleHealth(store, config, startedAt, extras?)` | `routes/health.ts` | `GET /api/health` — uptime, session counts, agent counts, repo list, `pipeline.runtimeMode`, spend/audit today counters |
| `handleSessions(store, usageStore?)` | `routes/sessions.ts` | `GET /api/sessions` — allowlist projection + numeric pending + spend summary |
| `handleSessionDetail(store, threadId, resolveSlackPermalink?, usageStore?)` | `routes/sessions.ts` | `GET /api/sessions/:threadId` — same allowlist plus `resumeCwd`, spend, and a best-effort Slack permalink |
| `handleDevServers(manager, queue, repos)` | `routes/dev-server.ts` | `GET /api/dev-server` — per-repo state, idle TTL remaining, queue depth |
| `handleWorkflows(registry, store, scheduler)` | `routes/workflows.ts` | `GET /api/workflows` — definitions, persisted state, recent runs, registry errors, and live scheduler-derived display status |
| `handlePipelines(store, params, runId?, options?)` | `routes/pipelines.ts` | `GET /api/pipelines` and `GET /api/pipelines/:runId` — summaries hide default-kind unless `includeDefault=1` or `kind=default`; detail expands leases/outbox/gates |
| `handlePipelineArtifact(store, runId, params, options?)` | `routes/pipelines.ts` | `GET /api/pipelines/:runId/artifacts?ref=` — relative-to-run-root file read, 256 KiB cap |
| `handleSpend(store, params)` | `routes/spend.ts` | `GET /api/spend` — usage `groupBy` over a host-local window (max 90 days) |
| `handleRunbooks(params, catalog?)` / `handleRunbookDetail(name, catalog?)` | `routes/runbooks.ts` | `GET /api/runbooks` and `GET /api/runbooks/:name` — registry + catalog + metrics |
| `handleAudit(store, params)` | `routes/audit.ts` | `GET /api/audit` — newest-first dashboard audit rows |
| `handleLogs(searchParams)` | `routes/logs.ts` | `GET /api/logs?date=YYYY-MM-DD` — parses daily log file (strict date regex prevents path traversal) |
| `handleProfiles(store, params)` | `routes/profiles.ts` | `GET /api/profiles` — read-only profile list/filter; never bumps `last_used_at` |
| `handleMemoryList()` | `routes/memory.ts` | `GET /api/memory` — list files under `docs/` |
| `handleMemoryRead(filePath)` | `routes/memory.ts` | `GET /api/memory/:path` — read a doc file (path-traversal guarded) |
| `handleMemoryRecall(store, params)` | `routes/memory.ts` | `GET /api/memory/recall` — semantic claim recall without recording dashboard usage |
| `handleMemoryProjection(store, params?)` | `routes/memory.ts` | `GET /api/memory/projection` — 3D PCA + spread + KNN projection for the memory galaxy; memoised per claim set, `?refresh=1` rebuilds |
| `resumeCmd(provider, sessionId, resumeCwd)` | `public/index.html` | Renders provider-correct Claude, OpenCode, or Codex resume commands from detail `resumeCwd`. |
| `projectClaims(claims, k?, spread?)` | `projection.ts` | PCA to 3D (power iteration + deflation) → separation relaxation → cosine KNN edges |

## Routes

```
GET /                       → public/index.html
GET /api/health             → handleHealth
GET /api/sessions           → handleSessions
GET /api/sessions/<id>      → handleSessionDetail
GET /api/dev-server         → handleDevServers
GET /api/workflows          → handleWorkflows
GET /api/pipelines          → handlePipelines (runtimeMode + default-kind hide)
GET /api/pipelines/<runId>  → handlePipelines (detail)
GET /api/pipelines/<runId>/artifacts?ref= → handlePipelineArtifact
GET /api/spend              → handleSpend
GET /api/runbooks           → handleRunbooks
GET /api/runbooks/<name>    → handleRunbookDetail
GET /api/audit              → handleAudit
GET /api/logs?date=...      → handleLogs
GET /api/profiles[?kind=…]  → handleProfiles
GET /api/memory             → handleMemoryList
GET /api/memory/<path>      → handleMemoryRead
GET /api/memory/recall      → handleMemoryRecall (503 if unavailable)
GET /api/memory/projection  → handleMemoryProjection (503 if unavailable)
    ?refresh=1                force a rebuild instead of the memoised result
GET /assets/three.module.js → locally served pinned Three.js module
GET /assets/three.core.min.js → locally served pinned Three.js core module
GET /assets/pipeline-worker.js → locally served pipeline worker
```

## Key Concepts

### Loopback-only threat model

Binds `127.0.0.1`. No CORS headers — same-origin from `public/index.html`. Don't expose this port. No auth. The internal MCP server is a separate loopback-only service.

### Path traversal guards

- Logs: `date` must match `^\d{4}-\d{2}-\d{2}$` exactly.
- Memory: rejects `..` and absolute paths; verifies resolved path stays inside `docs/`.

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

`index.ts` dynamic-imports `./http/server.ts` inside a try/catch — a port conflict on dashboard must not crash the bot.

## Dependencies

- **Uses**: `Bun.serve`, `SessionStore`, `DevServerManager`, `DevServerQueue`, `WorkflowRegistry`, `WorkflowScheduler`, `WorkflowStore`, `PipelineStore`, `UsageStore`, `DashboardAuditStore`, optional `MemoryStore`, `ProfileStore`, and runbook `CatalogStore`, optional Slack permalink resolver, `RepoConfig`, `logger`
- **Used by**: `src/index.ts` (gated on `config.http.enabled`)
