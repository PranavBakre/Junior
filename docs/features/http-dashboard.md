# HTTP Dashboard

## Problem

Operators running junior on a server have no live view of what's happening: which threads are active, which agents are busy, which pipeline holds a lease, what today cost, which workflow is running, and what the recent logs look like. The Slack home tab covers thread-list use cases but does not surface spend, pipeline leases/gates, runbooks, or dashboard-originated mutations.

**Who has this problem:** The operator (Pranav, mostly) tailing logs and `ps`ing for stuck processes.
**What happens today:** Open `http://127.0.0.1:<port>` on the host. The console lists sessions, continues or stops a thread, inspects pipelines, queries spend, triggers or edits Git-backed workflows, and browses runbooks and the audit log.
**"Finally" moment:** Continue a stuck thread, see who holds a pipeline lease, and check today's tokens without SSH + sqlite3.

This page documents the shipped operator console. The design record is [operator-dashboard-redesign.md](operator-dashboard-redesign.md).

## Shape

```
src/http/
├── server.ts              -- Bun.serve, matchApi route table, /js/* + /assets/*
├── match-api.ts           -- pathname + method matching; 405 on mismatch
├── query.ts               -- shared limit / host-local day / time-bound parsers
├── projection.ts          -- 3D PCA + spread + KNN for the memory galaxy
├── audit/                 -- DashboardAuditStore (memory + sqlite + factory)
└── routes/
    ├── health.ts          -- uptime, session/agent counters, spend/audit today
    ├── sessions.ts        -- allowlist list/detail + continue/stop
    ├── dev-server.ts      -- DevServerManager + DevServerQueue state
    ├── logs.ts            -- tail logs/<date>.log with tag/level filters
    ├── profiles.ts        -- read-only person/repo/project/situation browser
    ├── pipelines.ts       -- operator projection + relative artifact reads
    ├── workflows.ts       -- list/detail + enqueue/start/stop/reload + create/edit
    ├── spend.ts           -- usage groupBy over a host-local window
    ├── runbooks.ts        -- registry + catalog + metrics (view only)
    ├── audit.ts           -- newest-first dashboard_audit rows
    └── memory.ts          -- docs browser + claim recall + galaxy projection

src/usage/                 -- always-on spend ledger (not gated on the dashboard port)
src/workflows/git-commit.ts
public/
├── index.html             -- shell, CSS, nav, view mounts
├── pipeline-worker.js     -- 3D topology layout worker
└── js/                    -- same-origin modules (no bundler)
```

Bun-native: no router framework, no auth, no CORS. Static `public/index.html` plus `public/js/*` are served from the same origin as the API.

Junior is intentionally insecure as a networked product. The dashboard assumes a trusted local operator and host-level access control; exposing it beyond loopback requires adding authentication, authorization, and a real security review.

## Security posture

- **Loopback-only.** Binds `127.0.0.1` — never reachable off-host without an explicit SSH tunnel. This is the entire threat model; there is intentionally no auth layer behind it. Do not tunnel the port without adding auth.
- **Writes are in scope.** Continue, stop, workflow run/start/stop/reload, and Git-backed create/edit are first-class. They do not invent a second session/workflow runtime: continue/stop go through `SessionManager` (`injectDashboardContinue` / `interruptThread`); run/start/stop reuse scheduler enablement and `canManage` checks. Dashboard **run** is `enqueueManualRun` — Slack `!workflow run` still blocks on `runNow`. Create/edit use a dashboard-only scoped git helper (`src/workflows/git-commit.ts`); Slack never commits workflow files.
- **Audit is required, Slack-parity is not.** Every mutating call writes `dashboard_audit`. Session continue/stop also post to the Slack thread (conversation of record). Workflow mutations post a one-liner to a `slack` / `slack-thread` output **when the definition has one**. Workflows without an output channel leave only git + `dashboard_audit` — **weaker than Slack `!` commands**, accepted for a no-auth loopback console, and must not be documented as Slack-parity.
- **Actor is loopback identity.** `ADMIN_SLACK_USER_ID` when set, else `dashboard-operator`. Fail closed when the `admins` table is non-empty but the env admin is unset. Open-mode (neither tier configured) matches Slack open-mode.
- **Profiles are private operator data.** `/api/profiles` can include derived context about real people. It is available only inside the same loopback-only console and must not be exposed through a public bind or permissive CORS.
- **Same-origin.** Dashboard HTML is served by the same Bun process. No CORS headers — adding `Access-Control-Allow-Origin: *` would only let arbitrary websites the operator visits read this server's data.
- **Path-traversal rejection at the input layer.** `/api/logs?date=` accepts only `YYYY-MM-DD`; `/api/memory/<path>` rejects `..` and absolute paths and verifies the resolved path stays inside `docs/`. Pipeline artifact `ref` is relative to `data/pipelines/<runId>/` only. Workflow/runbook names must match `^[a-z0-9][a-z0-9-]*$`. Reject early, don't sanitize after concatenation.
- **Allowlist projection on `/api/sessions`.** Filesystem paths (`worktreePath`, `cwd`) stay off the list. Detail-only `resumeCwd` is the one path the resume CLI needs. PIDs, `systemPrompt`, `slackIdentity`, pending bodies, `activeTurnInput`, and assignment capability envelopes never leave the box. `pendingMessages` is a length.

## Write contract

Dashboard writes keep the loopback threat model. They do **not** stay read-only so Slack can be the only audit trail. Compensation, by action:

| Action | Slack conversation of record | Other trail |
|---|---|---|
| `session.continue` | Attribution-only post in the thread (no raw `!` lines) | `dashboard_audit` + `injectDashboardContinue` |
| `session.stop` | Same “Interrupted (N agents)” / “Nothing running.” line `!stop` posts | `dashboard_audit` + `slack_ts` |
| `workflow.run` / `start` / `stop` / `reload` | One-liner to the workflow’s Slack output channel **if present** | `dashboard_audit`; weaker than Slack if no output channel |
| `workflow.create` / `update` | Same optional one-liner | **git commit** is the reviewable record + `dashboard_audit` |

Pipeline, spend, runbook, profile, memory, log, and docs routes stay read-only. Killing a worktree, evicting a dev-server slot, and `!reset` / `!cancel` stay Slack-only.

### Continue / stop

`POST /api/sessions/:threadId/continue` `{ prompt, agentName? }`:

1. Validate prompt (non-empty, ≤ 8000 chars) and resolve the agent **before** Slack. `"junior"` / `"default"` / missing → top-level `handleMessage`. `"lead"` → `handleLeadMessage`. Any other name must already have an `agentSessions` row; otherwise 400. `"junior"` is never passed to `handleAgentMessage`.
2. Muted → 409, no Slack post.
3. Raw `chat.postMessage` of an attribution-only record (`*Dashboard continue* · local operator · …` plus a `>`-quoted 240-char preview). Slack body contains no line matching `^!(\S+)`. Slack failure → 502, **do not inject**.
4. `SessionManager.injectDashboardContinue` returns `{ accepted | buffered | muted }`. HTTP 202 for accepted/buffered. The Event API also drops posts that start with `*Dashboard continue*` so the echo cannot re-enter. `dashboardContinue` skips `routeDirectTaskThroughDefaultRun` and is ineligible for short-followup interrupt.
5. Dormant sessions proceed: clear `dormant` and set `needsThreadCatchup` (same as `!listen` / @mention). Do not change `targetRepo` / worktrees.

`POST /api/sessions/:threadId/stop` calls the same `interruptThread` body `!stop` uses (driver interrupt + `handle.kill`, keep the session), then posts `formatStopReply`. Slack post failure is `partial` on the audit row; the interrupt still happened. `!cancel` stays Slack-only.

### Workflow enqueue and Git writes

Slack `!workflow run` still awaits blocking `WorkflowScheduler.runNow`. The dashboard must not: Bun.serve’s idle timeout would kill a worklog-length request.

`POST /api/workflows/:name/run` calls `WorkflowScheduler.enqueueManualRun`:

- Same pre-checks as `runNow` (`enabled`, not `invalid`; `reason` is always `"manual"`, so `stopped` still allows a one-shot).
- Await `persistNewRun` so the `workflow_runs` row is durable **before** HTTP 202 `{ status: "started", runId }`.
- `void` only `executePersistedRun`. `schedule` / failed-run status / `releaseRun` hang on that promise, not on the HTTP method.
- `concurrency === "skip"` and already running → 200 `{ status: "skipped", runId: "" }` after `markSkipped`.
- `concurrency === "parallel"` may start a second overlapping run (202 after the new row is durable). Native handlers reject `instructions` (400). `enabled: false` is 409.

Create/edit write `*.workflow.md` and make a scoped git commit. Git is the source of authority; SQLite `workflow_states` / `workflow_runs` remain runtime.

| Policy | Behavior |
|---|---|
| Named branch only | Refuse detached HEAD (`git rev-parse --abbrev-ref HEAD` is `HEAD` or empty). Overlay also refuses unless that name is a real branch. Do not auto-checkout. |
| Repo safety | Refuse merge / rebase / unresolved conflicts (`UU`/`AA`/`DD`/`AU`/`UA`) on **any** path in the target repo. |
| Scoped add | `git add -- <relativePath>` only. Never `-A`. Isolated `user.name=Junior Dashboard` / `user.email=junior-dashboard@localhost`. No push, no PR, no force-push, no new branch. |
| Pause reloads | `registry.pauseReloads()` around write+commit so the 350 ms watcher cannot load uncommitted bytes. `resumeReloads()` reloads whatever is now on disk. Commit failure restores the file to HEAD (or deletes a new file) before resume. |
| Overlay parent pointer | Preflight **both** `agents-org` and Junior before writing the overlay file. After overlay `ok`, `git add -- agents-org` only on Junior’s named branch. Parent failure after overlay success is **not** rolled back: HTTP 200 with `overlayCommitted: true, parentPointerCommitted: false`. Public-root writes skip this step. |
| Non-`main`/`master` | Save requires an explicit `commitHereAnyway` checkbox (default off). Detached / merging / rebasing on either repo disable Save. |

Optimistic concurrency on PUT compares `expectedVersionHash` to the **on-disk** `fileVersionHash`, not last-known-good. GET detail always returns on-disk markdown plus both hashes and `runtimeUsesFile`.

## Session allowlist

Shared list + detail projector (`projectSession` in `routes/sessions.ts`):

```
threadId, channel, provider, sessionId, leadSessionId, status,
agentType, defaultAgent, activeAgentName, targetRepo, baseRef,
muted, dormant, verbosity, driverMode, lastActivity, createdAt,
lastError                      -- type + message only
pendingMessages                -- length, never bodies
hasWorktree                    -- Boolean(worktreePath || worktreePaths)
agents[]                       -- agentName, sessionId, status, lastActivity,
                                  pendingMessages (length), provider
spend                          -- { inputTokens, outputTokens, costUsd, turns }
```

Detail only: `resumeCwd` (`worktreePath || cwd`) and `slackPermalink`. List never emits filesystem paths.

## Pipeline operator view

Default UI is an **assignment swimlane + phase tape**, not the 3D topology graph. Topology stays behind a toggle (`public/js/pipelines.js`, `pipelineViewMode = "swimlane"`).

- Lanes are `assignment.targetAgent` (`lead`, `default`, then A–Z).
- Bars encode lease / pending / waiting / terminal; unleased pending is hollow.
- Phase tape is `transitions[]`. Click an assignment to load the rail (objective, lease, dispatch, outcomes, artifacts, attempt-scoped gates).
- `GET /api/pipelines` hides `kind=default` unless `includeDefault=1` or `kind=default`. `limit` default 50, max 200. Response includes `runtimeMode` from config (never inferred) and `openCount`.
- `GET /api/pipelines/:runId` expands leases, full-run outbox **without payload**, outcomes, gates, GitHub resources, dev-server jobs, and artifact refs. No pipeline writes (no force-transition, no replay).
- `GET /api/pipelines/:runId/artifacts?ref=` reads a path relative to `data/pipelines/<runId>/` only, 256 KiB cap. 400 on traversal, 404 if missing.

Empty copy: “No typed pipeline runs. Default-kind durability is hidden unless you enable it.”

## Spend ledger

Usage capture is **always-on** — not gated on `HTTP_DASHBOARD_PORT`. Tables live in `SESSION_DB_PATH` (`data/sessions.db`).

- Session turns: `SessionManager` records `done` via `normalizeRunnerUsage` + `sessionTurnSourceId` (unique `(source_kind, source_id)`; later `done` events for the same turn **sum**). Quiet verbosity cannot skip it.
- Workflow runs: once from `SpawnResult` after `runWithRunner`, keyed by `workflowRunId`. Native handlers insert a zero-token row with `raw: { nativeHandler }`.
- Pipeline assignment rows are not a third writer; session-turn rows already carry invocation ids.
- `costUsd` is Claude `total_cost_usd` only. `costEstimatedUsd` is always null. No `rates.ts`. Missing usage still inserts a row so “turns without telemetry” is visible.
- Retention: **90 days** for `usage_events`, **180 days** for `dashboard_audit`. `cleanupOperationalTables` runs from the same interval as stale-session cleanup and from `runCleanupFromEnv`.
- `GET /api/spend?from=&to=&groupBy=day|session|agent|provider|workflow|pipeline`. Default window is today 00:00 in the **host local** timezone (shown in the UI). Max range 90 days.

UI is table-first (KPI strip + `groupBy` chips + sortable buckets). No canvas chart.

## Runbook viewer

Runbooks stay a separate registry (`src/runbooks/`). The dashboard does not merge them with workflows and does not author or execute them.

- `GET /api/runbooks` — `searchRunbooks` (default 25 / max 100) joined with `getRunbook` (`filePath`), catalog, and `computeMetrics`. Empty registry is 200 `{ runbooks: [], errors: [] }`, not 503.
- `GET /api/runbooks/:name` — definition (including prompt body), catalog, metrics, git provenance. 404 if not loaded.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /` | `public/index.html` (dashboard UI) |
| `GET /js/*` | same-origin modules from `public/js/` (`Cache-Control: no-cache`) |
| `GET /api/health` | `{ status, uptime, startedAt, sessions, agents, repos[], pipeline: { runtimeMode, … }, spend: { eventsToday }, audit: { writesToday } }` |
| `GET /api/sessions` | Allowlisted sessions sorted by `lastActivity` desc, numeric pending, spend summary |
| `GET /api/sessions/:threadId` | Same allowlist plus `resumeCwd`, spend, and a best-effort Slack permalink |
| `POST /api/sessions/:threadId/continue` | `{ status: "accepted" \| "buffered" }` 202; 409 muted; 502 Slack failed |
| `POST /api/sessions/:threadId/stop` | `{ status: "ok", interrupted, message }` |
| `GET /api/dev-server` | Per-repo `{ devCommand, devPort, readyUrl, running, pid, branch, startedAt, lastUsedAt, idleMsRemaining, holder, waiters }` plus top-level `idleTtlMs` |
| `GET /api/workflows` | Definitions (`nativeHandler`, owners, permissions, concurrency), state, five recent runs, registry errors, live `displayStatus`, overlay/junior git probes |
| `GET /api/workflows/:name` | LKG/live projection (or null) + on-disk `source` (both hashes) + git + last 20 runs |
| `POST /api/workflows` | Create + scoped commit. 201. `sourceRoot` required (`public` \| `overlay`) |
| `PUT /api/workflows/:name` | Edit + scoped commit. `?validate=1` dry-run does not write |
| `POST /api/workflows/:name/run` | `enqueueManualRun` — 202 started or 200 skipped |
| `POST /api/workflows/:name/start` | `{ name, status: "active" }` |
| `POST /api/workflows/:name/stop` | `{ name, status: "stopped" }` |
| `POST /api/workflows/reload` | Admin `registry.reload()` + `scheduler.reconcile` |
| `GET /api/pipelines` | Summaries; default-kind hidden unless `includeDefault=1` or `kind=default` |
| `GET /api/pipelines/:runId` | Operator projection (leases, outbox without payload, gates, artifacts, …) |
| `GET /api/pipelines/:runId/artifacts?ref=` | `{ ref, content, truncated }` — 256 KiB cap |
| `GET /api/spend?from=&to=&groupBy=` | `{ from, to, totals, buckets }` |
| `GET /api/runbooks` | List + catalog + metrics |
| `GET /api/runbooks/:name` | Definition + catalog + metrics + git |
| `GET /api/audit?action=&targetType=&from=&to=&limit=` | Newest-first audit rows (default 100, max 500) |
| `GET /api/logs?date=YYYY-MM-DD&tail=N&tag=&level=` | Parsed entries from `logs/<date>.log` |
| `GET /api/profiles[?kind=person\|repo\|project\|situation]` | Derived profiles plus per-kind counts; inspection does not bump recall usage |
| `GET /api/memory` | List of `docs/**/*.md` paths |
| `GET /api/memory/:path` | Contents of one doc file |
| `GET /api/memory/recall?query=&tags=&kinds=&repo=&limit=` | Cosine-ranked claims; the route embeds the query, recall never records dashboard usage |
| `GET /api/memory/projection[?refresh=1]` | `{ points[{id,x,y,z,kind,text,tags,repo,weight,createdAt,lastUsedAt}], edges[{a,b,sim}], facets{tags,kinds,repos} }` |

`OPTIONS *` returns 204 (preflight handler kept for browsers that probe; no CORS headers attached). Unknown paths return JSON `{ error: "not found" }` 404. Wrong method on a known `/api/*` path returns 405 `{ error: "method not allowed" }`. Handler exceptions log to the `http` tag and return JSON 500 — the bot does not die on a route bug. Mutations also log on the `dashboard` tag.

The server also serves the locally pinned Three.js modules and pipeline worker under `/assets/`; these are fixed allowlisted paths, not a general static-file server.

## Memory galaxy

The `#memory` view renders the claim corpus as a navigable Three.js scene. The
server still owns semantic layout; the browser uploads projected claims as GPU
point sprites and KNN relationships as dynamic line buffers. Selection and hover
markers are native Three.js meshes. The scene owns the entire Memory viewport;
search, facets, camera controls, and the accessible claim rail are glass overlays
on that scene rather than a second visualization beside it. Three.js is served
locally from the pinned package dependency, so the localhost dashboard does not
depend on a CDN.

- **Why 3D.** In 2D, thousands of claims overlap into an unreadable smear no matter
  how the projection is tuned. Depth plus orbit/zoom gives the corpus somewhere to
  go, and the server-side spread pass guarantees stars don't sit on top of each
  other (see [the projection notes](../code_index/http-dashboard.md)).
- **GPU rendering.** One shader-driven `THREE.Points` draw call carries per-claim
  kind color, weight-derived size, and filter opacity. Ambient and focused links
  use separate `THREE.LineSegments` buffers so hover can brighten a local
  neighbourhood without rebuilding the projection.
- **Navigation.** Drag orbits, wheel zooms, shift-drag pans, click focuses a star
  and flies to it, double-click resets. The wheel handler is registered
  non-passive and calls `preventDefault` — otherwise the wheel scrolls the page
  behind the canvas instead of zooming.
- **Filtering.** Tag / kind / repo chips (AND across tags) plus a text box that
  substring-filters as you type and escalates to real semantic recall on ⏎ —
  the same embedding path an agent's `memory_recall` takes. Matches light up, the
  rest fade to background dust; `frame` fits the camera to the current match set.
- **Layout containment.** The Three.js canvas fills the fixed-height view and the
  claim rail overlays its right edge. The rail scrolls inside itself with
  `overscroll-behavior: contain`; without that, a wheel over it would zoom or
  scroll the scene behind the overlay.

## Configuration

```
HTTP_DASHBOARD_PORT=4567  # positive integer 1-65535. Unset = disabled.
```

- Unset/empty → `{ enabled: false }`, `startHttpServer` is never called from `index.ts`.
- Anything other than a positive integer in range throws at config load — better to fail boot than silently bind to a surprise port.
- `Bun.serve` startup failures (port in use, permissions) are caught and logged; the bot continues without the dashboard.
- Unsetting the port hides the UI. Spend capture (`usage_events` from `SessionManager` / `WorkflowExecutor`) and 90-day/180-day retention deletes stay always-on. `dashboard_audit` **inserts** happen only when a mutating HTTP route runs; they do not fire when the dashboard is off. `cleanupOperationalTables` deletes old usage/audit rows — it does not write them.

## Integration points

- **`SessionStore` / `SessionManager` ([session-persistence.md](session-persistence.md), [session-management.md](session-management.md)).** Reads go through the store. Writes go through `injectDashboardContinue` and `interruptThread` — not a second spawn path. HTTP never talks to a runner CLI.
- **`DevServerManager` ([process-lifecycle.md](process-lifecycle.md)).** `/api/dev-server` calls `manager.status()` and `manager.getIdleTtlMs()`.
- **`DevServerQueue`.** `queue.readQueueDepth(repo)` supplies `{ holder, waiters }`.
- **`WorkflowScheduler` / `WorkflowRegistry` ([dynamic-workflows.md](dynamic-workflows.md)).** List `displayStatus` uses the process-local active-run count. Dashboard run is `enqueueManualRun`; Slack keeps blocking `runNow`. Create/edit pause the registry, commit, then resume+reload.
- **`PipelineStore`.** Operator reads only. The HTTP projector is `src/http/routes/pipelines.ts`; `src/pipelines/projection.ts` remains the Slack/`!status` human summary.
- **`UsageStore`.** Always-on ledger in `data/sessions.db`. Dashboard queries it; capture does not depend on the port.
- **`DashboardAuditStore`.** Same DB. Required once write routes exist (no 503).
- **Runbook registry + `CatalogStore`.** View-only HTTP over the existing MCP/registry surface.
- **`logs/<date>.log`.** Written by `src/logger.ts`. Read-only parse of `<iso> [LEVEL] [tag] message`.
- **`docs/`.** Read-only doc browser, scoped to the project's `docs/` directory.

## Dependencies

- [session-management.md](session-management.md) — `ThreadSession` / inject / interrupt.
- [session-persistence.md](session-persistence.md) — `SessionStore`.
- [dynamic-workflows.md](dynamic-workflows.md) — registry, scheduler, git-backed definitions.
- [process-lifecycle.md](process-lifecycle.md) — `DevServerManager` / `DevServerQueue` / operational cleanup.
- [agent-product-debugging-pipeline-implementation-plan.md](agent-product-debugging-pipeline-implementation-plan.md) — typed run/assignment/outbox shape the swimlane reads.
- `three` — locally served WebGL runtime for the memory graph.

## Cut list (true v2)

- Auth (token, OAuth). Loopback binding is enough until junior runs on a multi-tenant host. A same-origin token would be theater.
- Server-Sent Events / WebSocket push. The UI still polls (~2s).
- Per-thread pending-message body view. Lengths only, by design.
- Kill a worktree, evict a dev-server slot, or `!reset` / `!cancel` from the dashboard. Those stay Slack `!` commands.
- Starting a new Slack thread from the dashboard. Continue existing sessions only.
- Dashboard-authored runbooks, runbook PRs, or merging runbooks into the workflow registry.
- Push / open a PR after a workflow commit. Commits stay local and unpushed.
- Binding the dashboard off loopback.
- Spend bar chart, estimated USD (`rates.ts`), or accurate cost for providers that do not emit `total_cost_usd`.
- Pipeline writes (force-transition, replay outbox) from the dashboard.

The previous cut-list line “write endpoints stay read-only — destructive ops go through Slack so they're auditable” is **superseded**. The compensating control is loopback + `dashboard_audit` + Slack posts where a destination exists. Workflow writes without a Slack output channel are an accepted weaker trail than Slack `!` commands.
