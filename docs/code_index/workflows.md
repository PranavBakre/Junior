# Code Index: Dynamic Workflows

Dynamic workflows are markdown-defined, typed runs scheduled and executed by
Junior. Definitions are data; the runtime owns validation, scheduling,
execution, persistence, and dashboard projection.

## Sources

| Symbol/area | File | Purpose |
|---|---|---|
| `WorkflowRegistry` | `src/workflows/registry.ts` | Loads definitions, applies overlay precedence, and watches for changes. |
| Definition parser | `src/workflows/definition.ts` | Parses and validates frontmatter/body workflow definitions. |
| `WorkflowScheduler` | `src/workflows/scheduler.ts` | Computes due work, persists scheduler state, and tracks live per-workflow run counts for operator projections. |
| `WorkflowExecutor` | `src/workflows/executor.ts` | Runs a validated workflow step through the configured runner boundary. |
| Controller | `src/workflows/controller.ts` | Coordinates registry, scheduler, executor, and store. |
| Store | `src/workflows/store.ts` | Persists workflow state and run history; definitions remain file-backed in the registry. |
| Types | `src/workflows/types.ts` | Workflow definition, trigger/output, state, run, and execution contracts. |

## Definitions

The current repository definitions are:

- `workflows/memory-consolidation.workflow.md`
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

The localhost dashboard exposes workflow state at `/api/workflows`; see
[the HTTP index](http-dashboard.md). Its `displayStatus` uses the scheduler's
live run count rather than persisted `running` history, which may be stale after
a hard restart. Workflow utility runs with an explicit cwd intentionally do not
inherit Junior's project MCP wiring.
