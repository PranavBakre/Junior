# Code Index: Durable Product and Bug Pipelines

Pipelines are the typed control plane for product and bug work. They remain
disabled by default (`PIPELINE_RUNTIME_MODE=off`) and can run in `shadow` or
`active` mode after the corresponding product/bug flag is enabled.

## Sources

| Area | Files | Purpose |
|---|---|---|
| Types and definitions | `src/pipelines/types.ts`, `src/pipelines/bug/definition.ts`, `src/pipelines/product/definition.ts` | Run, assignment, outcome, artifact, transition, and pipeline-specific state. |
| Controllers | `src/pipelines/bug/controller.ts`, `src/pipelines/product/controller.ts` | Start typed runs, apply transitions, and enqueue work. |
| Dispatch | `src/pipelines/dispatch.ts`, `src/pipelines/pump.ts` | Claim assignments and deliver them to agent sessions. |
| Persistence | `src/pipelines/store/*` | Memory and SQLite stores, versioned writes, and transactional outcome handling. |
| Reliability | `src/pipelines/outbox.ts`, `recovery.ts`, `settlement-recovery` paths | At-least-once outbox delivery, lease recovery, and settlement repair. |
| Outcomes | `src/pipelines/outcomes.ts`, `revision.ts`, `artifacts.ts` | Idempotent agent outcomes, revisions, artifacts, and handoffs. |
| Slack/`!status` summary | `src/pipelines/projection.ts` | Human-readable `projectRunSummary` for Slack status. Not the dashboard HTTP projector. |
| Dashboard operator projection | `src/http/routes/pipelines.ts` | List + detail + artifact read. Hides `kind=default` unless `includeDefault=1` or `kind=default`. Detail expands leases, full-run outbox (payload stripped), attempt-scoped gates, GitHub resources, dev-server jobs, artifact refs. |
| Retention cleanup | `src/pipelines/gc.ts` | Pipeline retention GC (`PIPELINE_RETENTION_DAYS`). |
| Legacy bridge | `src/pipelines/legacy-directives.ts`, `src/support/pipeline-guard.ts` | Safely maps selected legacy directives while preserving existing routing. |
| MCP tools | `src/pipelines/tools.ts` | Runner-facing pipeline read/write tools with scope and idempotency checks. |

## Runtime contract

`off` leaves legacy Slack routing unchanged. `shadow` keeps typed product/bug
controller starts and handoff conversion disabled while allowing explicitly
shadow-safe tool/reconciliation records; it never dispatches assignments or
delivers GitHub wakes. `active` enables typed controllers, assignments,
recovery, and optional GitHub reconciliation. The config loader rejects
product/bug flags unless the mode is `active`.

Assignments use leases and idempotency keys. The outbox is at-least-once, so
consumers and outcome writes must remain idempotent; version/CAS checks prevent
stale workers from overwriting newer state. Retention is controlled by
`PIPELINE_RETENTION_DAYS`.

The localhost dashboard defaults to a readable **dispatch trace** in
`public/js/pipelines.js`: run start/end, assignment source→target agents,
status, start/end/duration, dispatch objective, and latest outcome reply are all
visible inline. A secondary directed-flow view uses deterministic causal layout
from `public/js/pipeline-directed-flow-layout.js`: the run anchors the left,
assignment cards branch right, solid arrows show dispatches and reasons, and
dashed return arrows show replies. The static graph supports pan and zoom, while
clicking a card opens the complete assignment rail. Assignments are not provider
sessions.
There are no pipeline writes from the dashboard (no force-transition, no outbox
replay); those stay in Slack / MCP.

See [the HTTP index](http-dashboard.md) for the operator routes,
[the implementation plan](../features/agent-product-debugging-pipeline-implementation-plan.md)
for design history, and [GitHub reconciliation](github-reconciliation.md) for
the external review boundary.
