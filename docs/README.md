# Junior documentation

This directory describes the current Junior runtime and preserves older design
records where they explain why a decision was made. For current behavior,
prefer the root [README](../README.md), [CLAUDE.md](../CLAUDE.md), the code
indexes, and the source links in those documents.

## Start here

| Need | Document |
|---|---|
| Run Junior and configure providers | [README](../README.md) |
| Work on the repository safely | [CLAUDE.md](../CLAUDE.md) |
| Understand the runtime boundaries | [Architecture](architecture.md) |
| Check security assumptions | [Security](security.md) |
| Find a module quickly | [Code indexes](#code-indexes) |

## Current runtime surfaces

- [Runner providers](features/runner-providers.md): OpenCode CLI (default),
  OpenCode SDK, Claude headless/tmux, and Codex app-server.
- [Session management](features/session-management.md) and
  [session persistence](features/session-persistence.md): buffering, resume,
  SQLite state, cleanup, and provider-specific recovery.
- [Thread commands](features/thread-commands.md) and
  [Slack event handling](features/slack-event-handler.md): command parsing,
  persistent-agent directives, approvals, and App Home actions.
- [MCP server](features/mcp-server.md): loopback Slack, agent, memory,
  pipeline, GitHub, MongoDB, and WhatsApp tool surfaces.
- [Dynamic workflows](features/dynamic-workflows.md): markdown definitions,
  registry overlays, scheduler, executor, and dashboard state.
- [Pipeline implementation](features/agent-product-debugging-pipeline-implementation-plan.md):
  typed product/bug runs, assignments, outbox delivery, recovery, and GC.
- [GitHub reconciliation](code_index/github-reconciliation.md): review-state
  reads, idempotent comments, and optional polling/event wake-up.
- [Memory v3](features/memory-system-v3.md): source records, claims, profiles,
  local embeddings, recall, and consolidation.
- [Worktrees and dev servers](features/bug-pipeline-worktrees.md) plus
  [worktree runtime](features/worktree-manager.md): target-repo isolation and
  the serialized dev-server slot.
- [WhatsApp archive](features/whatsapp-tools.md): optional ingestion and
  admin-gated read/search tools.

## Code indexes

Indexes map current symbols to source files. The most recently added runtime
surfaces have dedicated indexes:

- [Agent catalog](code_index/agent-catalog.md)
- [Codex app-server](code_index/codex-app-server.md)
- [GitHub reconciliation](code_index/github-reconciliation.md)
- [HTTP dashboard](code_index/http-dashboard.md)
- [MCP server](code_index/mcp-server.md)
- [Pipelines](code_index/pipelines.md)
- [Project setup and boot](code_index/project-setup.md)
- [Runner providers](code_index/runner-providers.md)
- [Support router](code_index/support-router.md)
- [Workflows](code_index/workflows.md)

The remaining indexes are listed by module in `docs/code_index/`.

## Historical and proposal documents

Feature files with an explicit `Historical`, `Proposal`, `Future`, or
`Superseded` status are retained as design history. In particular, the older
Codex runner plans, associative-memory designs, and pre-v3 memory plans are
not implementation contracts. When a historical document names a path or
agent that no longer exists, use its status banner and follow the linked
current index instead.

## Updating docs

When changing a runtime surface, update its code index and feature document,
then update [CLAUDE.md](../CLAUDE.md) or [README](../README.md) only when the
change affects operator behavior, configuration, commands, or architecture.
Run `git diff --check`, `bun run typecheck`, `bun test`, and an internal-link
check before handing off a documentation change.
