# Code Index: Dynamic Workflows

Dynamic workflows are markdown-defined, typed runs scheduled and executed by
Junior. Definitions are data; the runtime owns validation, scheduling,
execution, persistence, and dashboard projection.

## Sources

| Symbol/area | File | Purpose |
|---|---|---|
| `WorkflowRegistry` | `src/workflows/registry.ts` | Loads definitions, applies overlay precedence, and watches for changes. |
| Definition parser | `src/workflows/definition.ts` | Parses and validates frontmatter/body workflow definitions. |
| `WorkflowScheduler` | `src/workflows/scheduler.ts` | Computes due work and persists scheduler state. |
| `WorkflowExecutor` | `src/workflows/executor.ts` | Runs a validated workflow step through the configured runner boundary. |
| Controller | `src/workflows/controller.ts` | Coordinates registry, scheduler, executor, and store. |
| Store | `src/workflows/store.ts` | Persists workflow definitions/runs and their state. |
| Types | `src/workflows/types.ts` | Workflow definition, run, step, and execution contracts. |

## Definitions

The current repository definitions are:

- `workflows/memory-consolidation.workflow.md`
- `workflows/release-notes.workflow.md`
- `workflows/worklog.workflow.md`
- `workflows/worktree-prune.workflow.md`

Private overlay definitions may be loaded from `agents-org/workflows/` when
that directory exists. Overlay precedence and file-watch reload behavior are
implemented in the registry, not in individual workflow files.

The localhost dashboard exposes workflow state at `/api/workflows`; see
[the HTTP index](http-dashboard.md). Workflow utility runs with an explicit
cwd intentionally do not inherit Junior's project MCP wiring.
