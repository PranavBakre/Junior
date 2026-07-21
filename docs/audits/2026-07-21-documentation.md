# Documentation audit — 2026-07-21

## Scope

Audited the operator entry points (`README.md`, `CLAUDE.md`, `.env.example`),
architecture/security docs, feature pages, code indexes, executable workflow
definitions, and the current `src/` module inventory. The audit covered runner
providers, sessions/persistence, agent routing, MCP/HTTP surfaces, worktrees,
memory, workflows, pipelines, GitHub reconciliation, and WhatsApp archive tools.

## Agent audit

Three read-only audit agents ran in parallel. They inspected the repository and
reported findings without modifying files:

1. Runtime/source inventory and missing code indexes.
2. Feature-document claims versus current implementation.
3. README/CLAUDE/config/operator-surface drift and stale references.

The audits converged on the same high-impact drift: provider support was
understated, the default agent catalog still named retired roles, persistence
was described as an in-memory map, MCP and dashboard routes were incomplete,
and several shipped features were still framed as proposals.

## Updates made

- Documented all four implemented runner paths: OpenCode CLI, OpenCode SDK,
  Claude headless/tmux, and Codex app-server.
- Corrected the SQLite/session, pipeline/workflow, memory, GitHub, WhatsApp,
  and MCP/HTTP descriptions and configuration references.
- Added current code indexes for the agent catalog, Codex app-server, GitHub
  reconciliation, pipelines, support router, and workflows.
- Added `docs/README.md` as the canonical documentation map and marked older
  plans/design records as historical where their paths or roles are no longer
  current.
- Corrected worktree/dev-server paths and the delegated setup-command contract.
- Updated command, driver, thread archive, security, and agent-action-button
  documentation to match shipped behavior.
- Corrected `.env.example` so `PRE_RECALL_ENABLED=false` matches the source
  default.

## Deliberate non-changes

The audit found an unrelated current UI-label issue in
`public/index.html` around provider resume labels. It was not changed because
this task is a documentation audit and the issue does not make the docs more
accurate. Historical design records remain in place when they provide useful
decision context, but current-status banners point readers to the live indexes.

## Verification (first pass)

- `git diff --check`: passed.
- Internal Markdown link check: passed for 111 tracked/current Markdown files.
- `bun test`: passed — 1,277 tests, 2 model-download skips, 0 failures.
- `bun run typecheck`: still fails on pre-existing MCP/Zod schema typing errors
  in `src/mcp/slack-server.ts`, `src/mcp/mongodb-proxy.ts`, and
  `src/mcp/whatsapp-tools.ts`. No source files in those modules were changed by
  this audit; dependency refresh from the committed lockfile removed unrelated
  duplicate-package errors but not the existing MCP typing mismatch.

The same formatting, link, test, and typecheck checks are repeated after the
first clean documentation pass and before the commit/PR handoff.
