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
| Projection and cleanup | `src/pipelines/projection.ts`, `src/pipelines/gc.ts` | Dashboard projections and retention cleanup. |
| Legacy bridge | `src/pipelines/legacy-directives.ts`, `src/support/pipeline-guard.ts` | Safely maps selected legacy directives while preserving existing routing. |
| MCP tools | `src/pipelines/tools.ts` | Runner-facing pipeline read/write tools with scope and idempotency checks. |

## Runtime contract

`off` leaves legacy Slack routing unchanged. `shadow` records eligible starts
without dispatching or mutating legacy ownership. `active` enables typed
controllers, assignments, recovery, and optional GitHub reconciliation. The
config loader rejects product/bug flags unless the mode is `active`.

Assignments use leases and idempotency keys. The outbox is at-least-once, so
consumers and outcome writes must remain idempotent; version/CAS checks prevent
stale workers from overwriting newer state. Retention is controlled by
`PIPELINE_RETENTION_DAYS`.

See [the implementation plan](../features/agent-product-debugging-pipeline-implementation-plan.md)
for design history and [GitHub reconciliation](github-reconciliation.md) for
the external review boundary.
