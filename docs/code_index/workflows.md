# Code Index: Dynamic Workflows

Dynamic workflows are markdown-defined, typed runs scheduled and executed by
Junior. Definitions are data; the runtime owns validation, scheduling,
execution, persistence, and dashboard projection. The localhost dashboard can
also enqueue, start, stop, reload, create, and edit workflows; see
[the HTTP index](http-dashboard.md).

## Sources

| Symbol/area | File | Purpose |
|---|---|---|
| `WorkflowRegistry` | `src/workflows/registry.ts` | Loads definitions, applies overlay precedence, and watches for changes. `pauseReloads` / `resumeReloads` wrap dashboard git writes so the 350 ms watcher cannot load uncommitted bytes. |
| `verifyWorkflowProvenance` | `src/workflows/provenance.ts` | Verifies the working-tree blob against the configured default-branch tree (`origin/main` in production) and returns the verified commit SHA. Missing, untracked, or branch-only definitions are unpublished and omitted from the active registry. |
| Definition parser | `src/workflows/definition.ts` | Parses and validates frontmatter/body workflow definitions. `WORKFLOW_NAME_RE` is the HTTP name guard. |
| `WorkflowScheduler` | `src/workflows/scheduler.ts` | Computes due work, persists scheduler state, and tracks live per-workflow run counts for operator projections. |
| `runNow` | `src/workflows/scheduler.ts` | Blocking manual/scheduled entry. Slack `!workflow run` still uses this. |
| `enqueueManualRun` | `src/workflows/scheduler.ts` | Dashboard fire-and-forget: await `persistNewRun`, void `executePersistedRun` with `.then(schedule)` / `.catch` (failed-run status) / `.finally(releaseRun)`. Returns `{ status: "started", runId }` or `{ status: "skipped", runId: "" }`. |
| `persistNewRun` / `executePersistedRun` | `src/workflows/executor.ts` | Split so HTTP can 202 only after the `workflow_runs` row is durable. `run()` still does persist then execute. Persists usage once from `SpawnResult` (or a zero-token native-handler row). |
| `writeDashboardWorkflow` / `preflightGitRepo` / `probeWorkflowRepo` | `src/workflows/git-commit.ts` | Scoped `git add -- <path>` + isolated identity commit. Refuses detached HEAD, merge, rebase, conflicts. Overlay: preflight Junior, then parent-pointer `git add -- agents-org` only; parent failure does not roll back the overlay. No push. |
| Controller | `src/workflows/controller.ts` | Coordinates registry, scheduler, executor, and store. |
| Store | `src/workflows/store.ts` | Persists workflow state and run history, including each run's verified default-branch commit SHA; definitions remain file-backed in the registry. |
| Types | `src/workflows/types.ts` | Workflow definition, trigger/output, state, run, and execution contracts. |

## Definitions

The current repository definitions are:

- `workflows/memory-consolidation.workflow.md`
- `workflows/memory-decay-report.workflow.md` (native, report-first stale-claim
  decay; archival requires the CLI `--apply` gate)
- `workflows/memory-dedup-sweep.workflow.md` (native, report-only — see
  [claim-dedup-write-guard.md](../features/claim-dedup-write-guard.md))
- `workflows/release-notes.workflow.md`
- `workflows/slack-archive-maintenance.workflow.md` (native, deterministic
  Slack archive/index maintenance)
- `workflows/worklog.workflow.md`
- `workflows/worktree-prune.workflow.md`

Private overlay definitions may be loaded from `agents-org/workflows/` when
that directory exists. Overlay precedence and file-watch reload behavior are
implemented in the registry, not in individual workflow files.

The localhost dashboard exposes workflow state at `/api/workflows` and mutations
at `/api/workflows` (POST create), `/api/workflows/:name` (PUT edit, `?validate=1`
dry-run), `/api/workflows/:name/run|start|stop`, and `/api/workflows/reload`.
`displayStatus` uses the scheduler's live run count rather than persisted
`running` history, which may be stale after a hard restart. Dashboard **run**
calls `enqueueManualRun`, not blocking `runNow`. Create/edit refuse detached
HEAD and pause registry reloads around the commit.

Workflow mutations write `dashboard_audit`. They post a one-liner to a
definition Slack output channel when one exists; **without that channel the
trail is weaker than Slack `!` commands** (git + audit only). Actor is
`ADMIN_SLACK_USER_ID` or `dashboard-operator`.

Workflow utility runs with an explicit cwd intentionally do not inherit Junior's
project MCP wiring.

## Git provenance

The registry is fail-closed for executable definitions. Public and private
overlay roots are checked against their configured default ref (normally
`origin/main`) before a file enters the registry. The file's bytes must match
the default-ref blob exactly; a feature-branch edit, untracked file, missing
default ref, or definition absent from that tree is reported as
`Workflow is unpublished` and cannot be scheduled or manually run. A verified
definition carries the default-ref commit SHA, and every persisted run copies
that SHA into `workflow_runs.verified_commit_sha` and the run artifact.
