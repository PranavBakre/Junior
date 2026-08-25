# Code Index: Durable Product and Bug Pipelines

Pipelines are the typed control plane for product and bug work. They remain
disabled by default (`PIPELINE_RUNTIME_MODE=off`) and can run in `shadow` or
`active` mode after the corresponding product/bug flag is enabled.

## Sources

| Area | Files | Purpose |
|---|---|---|
| Types and definitions | `src/pipelines/types.ts`, `src/pipelines/bug/definition.ts`, `src/pipelines/product/definition.ts` | Run, assignment, outcome, artifact, transition, and pipeline-specific state. |
| Controllers | `src/pipelines/bug/controller.ts`, `src/pipelines/product/controller.ts` | Start typed runs, apply transitions, and enqueue work. |
| Dispatch | `src/pipelines/dispatch.ts`, `src/pipelines/pump.ts` | Claim assignments and deliver them to agent sessions, restoring bounded Slack attachments from durable state. |
| Slack attachment durability | `src/slack/files.ts`, `src/pipelines/default/controller.ts`, `src/session/manager.ts` | Bounds the existing `SlackFileAttachment` contract, stores refs on default assignments/outbox payloads, and restores them on synthetic dispatch events. |
| Structured monitoring | `src/pipelines/logging.ts`, dispatch, settlement, outcome, and GitHub review modules | Emits searchable `event=...` lifecycle records keyed by run, thread, assignment, and agent. |
| Persistence | `src/pipelines/store/*` | Memory and SQLite stores, versioned writes, and transactional outcome handling. |
| Reliability | `src/pipelines/outbox.ts`, `recovery.ts`, `settlement-recovery` paths | At-least-once outbox delivery, lease recovery, and settlement repair. |
| Outcomes | `src/pipelines/outcomes.ts`, `revision.ts`, `artifacts.ts` | Idempotent agent outcomes, revisions, artifacts, and handoffs. |
| Generic outcome policy | `src/pipelines/policy.ts` | Validates transition shape, authority-sensitive blockers, progress fingerprints, and reviewer completion evidence. Review completion requires a head-pinned verdict receipt plus a runtime-evidence receipt (or explicit `not-applicable:<reason>`). |
| Slack/`!status` summary | `src/pipelines/projection.ts` | Human-readable `projectRunSummary` for Slack status. Not the dashboard HTTP projector. |
| Dashboard operator projection | `src/http/routes/pipelines.ts` | List + detail + artifact read. Hides `kind=default` unless `includeDefault=1` or `kind=default`. Detail expands leases, full-run outbox (payload stripped), attempt-scoped gates, GitHub resources, dev-server jobs, artifact refs. |
| Retention cleanup | `src/pipelines/gc.ts` | Pipeline retention GC (`PIPELINE_RETENTION_DAYS`). |
| Full cancellation | `PipelineStore.cancelRun`, `SessionManager` `!stop` handling | Atomically abandons the run, cancels live assignments/jobs, dead-letters pending or leased wakes, deactivates GitHub tracking, clears session invocation state, and interrupts runner handles. |
| Legacy bridge | `src/pipelines/legacy-directives.ts`, `src/support/pipeline-guard.ts` | Safely maps selected legacy directives while preserving existing routing. |
| MCP tools | `src/pipelines/tools.ts`, `src/session/manager.ts` | Runner-facing pipeline read/write tools with scope and idempotency checks. Every durable assignment receives `pipeline_get_state` and `pipeline_report_outcome` in its provider permission envelope, including repo-backed workers. |

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

Ordinary Slack messages routed through an active default run retain up to eight
attachment references (bounded URL, filename, and MIME type fields) on the
assignment and its dispatch outbox item. The pump validates those JSON refs and
reconstructs `SlackMessageEvent.files` before `SessionManager` downloads them;
missing refs remain backward-compatible with older outbox rows.

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

## Operational logging

Pipeline records use the `pipeline` log tag and a compact key/value format:
`event=<name> run=<id> thread=<id> assignment=<id> ...`. The event names form a
single trace across the main failure boundaries:

- `assignment.dispatch.*` and `workspace.*` cover assignment delivery and
  repository/worktree binding.
- `action.button.dispatch` records Slack action-button follow-ups, including
  whether the action intentionally bypasses creation of a new default run.
- `assignment.runner.completed`, `settlement.*` cover provider completion,
  durable outcome detection, recovery continuations, and escalation persistence.
- `outcome.tool.*` and `outcome.receipt.*` cover MCP invocation, authorization,
  validation, and the durable transition receipt.
- `github.api.*` and `github.review.*` cover each fixed GitHub API endpoint,
  status code, latency, review verification, and final result. Request bodies,
  review text, and command output are intentionally excluded from monitoring
  logs.

For an incident, filter the daily log by the run or assignment ID, then follow
the event sequence. A GitHub access failure is now visible as
`github.api.completed ... status=... http_status=... ok=false`; a missing typed outcome is
visible as `settlement.recovery_requested` followed by
`settlement.escalated`.

See [the HTTP index](http-dashboard.md) for the operator routes,
[the implementation plan](../features/agent-product-debugging-pipeline-implementation-plan.md)
for design history, and [GitHub reconciliation](github-reconciliation.md) for
the external review boundary.
