# CLAUDE.md — junior

## Project Overview

junior is a Slack bot that acts as the control plane for coding-agent sessions. OpenCode is the default runner provider; OpenCode SDK, Claude Code, and Codex app-server are also implemented. Claude tmux is an opt-in interactive driver. It's the successor to the OpenClaw-based agent system (PranavBakre/openclaw-agents).

The server owns the lifecycle. When a Slack message arrives in a thread, the bot spawns a runner turn through the selected provider. Headless OpenCode/Claude turns are short-lived subprocesses; Claude tmux mode keeps an interactive process alive behind a per-thread driver flag. Each thread gets its own isolated session and optional target-repo worktree.

**Stack:** Bun, TypeScript, Slack Event API, OpenCode CLI/SDK, Claude Code CLI, Codex app-server, SQLite, dynamic workflows, and durable product/bug pipeline state.

**Key architectural choice:** providers are behind one normalized runner boundary. Headless CLI turns spawn one short-lived process per turn; server-attached providers keep their own runtime connection. Provider-native resume carries conversation context, but durable session/pipeline/artifact state remains authoritative after restart or recovery.

## Where to Look

**Read docs first — don't explore the codebase when a doc answers the question.**

| Question | Read this |
|---|---|
| System architecture, data flow, module dependencies? | [docs/architecture.md](docs/architecture.md) |
| How does Slack event handling work? | [docs/features/slack-event-handler.md](docs/features/slack-event-handler.md) |
| Thread context, persona, images, file upload, browser? | [docs/features/thread-context.md](docs/features/thread-context.md) |
| How does session management work (buffer, batch, drain)? | [docs/features/session-management.md](docs/features/session-management.md) |
| How does Claude CLI spawning work? | [docs/features/claude-spawner.md](docs/features/claude-spawner.md) |
| How do streaming updates to Slack work? | [docs/features/stream-to-slack.md](docs/features/stream-to-slack.md) |
| How does worktree isolation work? | [docs/features/worktree-manager.md](docs/features/worktree-manager.md) |
| How does agent routing work? | [docs/features/agent-routing.md](docs/features/agent-routing.md) |
| What agent definitions exist and how are they structured? | [docs/features/agent-definitions.md](docs/features/agent-definitions.md) |
| How do thread commands (!build, !reset, !status) work? | [docs/features/thread-commands.md](docs/features/thread-commands.md) |
| How does process lifecycle and error handling work? | [docs/features/process-lifecycle.md](docs/features/process-lifecycle.md) |
| How are spawned child process trees cleaned up on shutdown? | [docs/features/process-tree-cleanup.md](docs/features/process-tree-cleanup.md) |
| How does the bot Slack MCP server work? | [docs/features/mcp-server.md](docs/features/mcp-server.md) |
| How does the WhatsApp message archive + read tools work? | [docs/features/whatsapp-tools.md](docs/features/whatsapp-tools.md) |
| How does Junior's long-term memory work (claims, episodes, profiles, embeddings, recall, consolidation)? | [docs/features/memory-system-v3.md](docs/features/memory-system-v3.md) |
| Headless vs tmux driver, why two paths exist, how tmux runs the TUI? | [docs/features/interactive-driver.md](docs/features/interactive-driver.md) |
| How do persistent agents (orchestrator, reproducer, review, …) work? | [docs/features/persistent-agents.md](docs/features/persistent-agents.md) |
| How are bug-pipeline worktrees laid out? | [docs/features/bug-pipeline-worktrees.md](docs/features/bug-pipeline-worktrees.md) |
| How do sessions persist across restarts? | [docs/features/session-persistence.md](docs/features/session-persistence.md) |
| How does the localhost HTTP dashboard work? | [docs/features/http-dashboard.md](docs/features/http-dashboard.md) |
| How do dynamic workflows load, schedule, and run? | [docs/features/dynamic-workflows.md](docs/features/dynamic-workflows.md) |
| How do durable product/bug pipelines dispatch and recover? | [docs/features/agent-product-debugging-pipeline-implementation-plan.md](docs/features/agent-product-debugging-pipeline-implementation-plan.md) |
| How does GitHub PR/resource reconciliation work? | [docs/code_index/github-reconciliation.md](docs/code_index/github-reconciliation.md) |
| How do provider-neutral agent capabilities and handoffs work? | [docs/code_index/agent-catalog.md](docs/code_index/agent-catalog.md) |
| Project setup, config, directory structure? | [docs/features/project-setup.md](docs/features/project-setup.md) |
| Known limitations and open questions? | [docs/features/v2-backlog.md](docs/features/v2-backlog.md) |
| Code index for a specific module? | `docs/code_index/<module>.md` (matches feature doc names) |
| Current workflow definitions and docs map? | [docs/README.md](docs/README.md) and [`workflows/`](workflows/) |

## Architecture

```
Slack Event API (message.channels, app_mention)
    |
    v
Slack Bot Server (Bun)
    |
    +-- Session Manager: durable ThreadSession per thread
    |     session = { sessionId, worktreePaths, status, pendingMessages, pipeline state }
    |
    +-- On message:
    |     1. Look up thread_id
    |     2. If busy -> buffer message (react with eyes)
    |     3. If idle -> spawn selected runner provider
    |     4. On exit -> post response to Slack, drain buffer
    |
    +-- Runner provider boundary
          OpenCode CLI / OpenCode SDK / Claude CLI / Codex app-server
          normalized events + provider-native resume
    +-- Durable workflows and product/bug pipelines
          markdown definitions → scheduler/executor
          typed runs → assignments → outbox → agent sessions
```

## Prerequisites

Install and authenticate the tools required by the provider and agents you enable:
- **OpenCode** (default runner provider)
- **Claude Code CLI** (Claude provider and tmux driver)
- **Codex CLI/app-server** (Codex provider)
- Observability CLIs such as Vercel, New Relic, or Sentry only when the
  private overlay agents that use them are enabled.
- **tmux 3.4+** (required only for `DEFAULT_CLAUDE_DRIVER=tmux`)

## Critical Rules

1. **Use the provider boundary.** OpenCode CLI is the default; OpenCode SDK,
   Claude, and Codex app-server are implemented adapters. Keep provider-specific
   arguments, parsing, and policy inside their adapter modules.
2. **Match lifecycle to the provider.** Headless CLI turns are short-lived
   processes; server-attached OpenCode SDK/Codex providers own their connection;
   Claude tmux is an explicit interactive exception.
3. **Use native resume when enabled.** Provider-native continuity uses
   OpenCode sessions, Claude `--resume`, or Codex app-server thread state.
   Durable session and pipeline state remains authoritative.
4. **Buffer, don't interrupt.** If a runner is mid-execution and new messages arrive, buffer them. Do not kill the running turn except through the explicit stop/driver interrupt path. Drain the buffer as a combined prompt after the current turn exits.
5. **Worktrees for target repos only.** Junior's workspace is shared across all threads (learnings accumulate). Worktrees are created in TARGET repos (example-backend, example-frontend) when threads need code isolation. Threads that only read or discuss don't need worktrees.
6. **Stream events for status.** Parse provider-native streams from OpenCode,
   Claude, and Codex into normalized runner events and post incremental Slack
   updates. `SpawnHandle.onEvent` is the in-process callback boundary.
7. **Durable state is authoritative.** Session, action, workflow, pipeline, and
   artifact stores are the source of truth for restart/recovery. In-memory maps
   are caches or test implementations, not the production contract.
8. **Cleanup stale sessions.** The cleanup job deletes stale idle/draining session rows (24h default). Worktree removal is separate and must dirty-check before destructive cleanup.
9. **Runner MCP contract.** Worktree-backed target-repo runs get Junior's local
   MCP wiring. Claude receives the project `.mcp.json` via `--mcp-config`; OpenCode
   and Codex receive generated MCP config. Runs with an explicit `session.cwd`
   skip Junior's project MCP wiring because utility commands need their own cloud
   integrations. Run context is signed and scoped per spawn.
10. **No `--input-format stream-json` in production.** The bidirectional streaming flag exists but is undocumented and unstable. Use `--resume` for multi-turn until the protocol is specified.
11. **SQLite for persistence.** Sessions, actions, workflow runs, pipeline state,
   and memory use SQLite-backed stores by default. `SESSION_STORE=memory` is for
   tests/dev. The home tab shows only sessions active in `HOME_WINDOW_MS`; cleanup
   and health still scan all rows. Pending messages are persisted but stale after
   restart because the process they were queued behind is dead.
12. **Handle stalled processes and recovery.** Keep a hard timeout guard, use
   provider-specific idle recovery where supported, handle process errors, and
   clear timers/handles on exit. Server-attached providers manage their own
   connection lifecycle.
13. **Design for swappability.** When adding infrastructure that could have multiple implementations (persistence, message queue, notification), use a provider/factory pattern. Each provider gets its own file, a factory selects the right one.
14. **Pure functions over framework ceremony.** If a library's core value is bypassed, replace it with the simplest implementation. A 20-line function beats a dependency you're working around.
15. **Test against real infrastructure, mock at boundaries.** Mock Slack API and runner CLIs at system boundaries. Don't mock internal session management or message routing.

## Engineering Principles

1. **Sync before reading.** Any agent dispatch (or you reading source to draw a conclusion) needs `git fetch && git log @{u}` first. Stale checkouts produce confidently-wrong analysis with no error signal.
2. **Read current state before planning.** Run `git status` / `git diff --stat` / the obvious query before proposing a multi-step plan. Plans built from recall stay plausible until execution touches reality.
3. **Trust the build, not the LSP.** When editor diagnostics fire but `bun run typecheck` is green, the LSP is reading stale context. Verify against the build before refactoring code that wasn't broken.
4. **Code tracing is inference, not evidence — execute to verify.** Pure mock-runs prove the shape of intermediate values; only an integration test proves behavior. Match verification scope to the claim.
5. **Categorize before bulk action.** "Dirty," "globally," "missing" each name several distinct cases. Classify per-item (junk / extractable / mergeable / real-work) before picking the operation.

## Project Structure

```
junior/
  src/
    index.ts              -- entry point: start Slack app, wire everything
    config.ts             -- env loading, config validation
    slack/
      app.ts              -- Bolt app setup, Socket Mode
      events.ts           -- event listeners, message routing
      commands.ts         -- slash command parsing
      formatting.ts       -- Slack message formatting
    session/
      manager.ts          -- session state machine (buffer/drain)
      types.ts            -- ThreadSession interface
      store/
        interface.ts      -- SessionStore interface
        factory.ts        -- createSessionStore(config)
        memory.ts         -- InMemorySessionStore (tests, dev)
        sqlite.ts         -- SqliteSessionStore (production)
    runners/
      index.ts            -- select the normalized runner provider
      runtime.ts          -- shared cwd/env/MCP runtime contract
      mcp-config.ts       -- generated OpenCode/Codex MCP configuration
    opencode/
      spawner.ts          -- spawn OpenCode CLI, parse JSON events
      sdk-provider.ts     -- OpenCode SDK provider
    claude/
      spawner.ts          -- spawn claude -p for headless mode
      tmux-driver.ts      -- interactive Claude driver behind tmux
      args.ts             -- build CLI args from session state
      parser.ts           -- stream-json line parser
      types.ts            -- stream-json event types
    codex-app-server/     -- Codex app-server adapter, parser, policy, config
    worktree/
      manager.ts          -- create/remove/check worktrees in target repos
      types.ts            -- RepoConfig
    agents/
      router.ts           -- load definitions and build prompts
      loader.ts           -- read .md files and parse frontmatter
      manifest.ts         -- catalog capabilities and handoff policy
      registry.ts         -- reloadable public/private definition registry
      verification.ts     -- definition and policy checks
    memory/               -- v3 long-term memory (see docs/features/memory-system-v3.md)
      sqlite.ts           -- SqliteMemoryStore: source records, claims, episodes, decay
      store.ts            -- MemoryStore interface
      types.ts            -- claim / episode / decay / source-record types
      ingestion.ts        -- MemoryIngestor: hot-path appendSourceRecord capture
      cli.ts              -- consolidate-v3 / recall-claims / add-claim / add-lesson / add-fact
      migrate-v3.ts       -- one-shot: legacy lesson+fact -> claim, then drop condemned tables
      embedding/          -- local harrier-270 ONNX provider + hashing stub (factory)
      profiles/           -- keyed markdown entity profiles (person/repo/situation), ProfileStore
      consolidation/      -- offline LLM write path: consolidateSession + sweep + claude -p runner
    lifecycle/
      timeout.ts          -- process timeout guard
      health.ts           -- orphan detection
      shutdown.ts         -- graceful bot shutdown
      dev-server.ts       -- per-repo dev-server manager
      dev-server-queue.ts -- single-flight dev-server activation
    pipelines/             -- durable product/bug runs, outbox, recovery, GC
    workflows/             -- markdown workflow registry, scheduler, executor
    github/                -- optional GitHub reconciliation and review writes
    whatsapp/              -- optional passive WhatsApp archive
    time/                  -- injectable clock for deterministic behavior
  .claude/
    agents/               -- agent definitions (junior's own, not target repo's)
      common/
        building-philosophy.md
        bug-pipeline.md     -- merged orchestrator playbook (lead+thinker); appended to support-channel (lead) sessions
      default.md            -- the one Junior orchestrator; `lead`/`thinker` session markers alias to this file
      build.md
      review.md
      frontend.md
      architect.md
      pm.md
      reproducer.md

  docs/
    features/             -- feature design docs with iteration plans
    code_index/           -- code indexes per module
  workflows/              -- executable workflow definitions (worklog, release notes, memory consolidation, worktree prune)
  CLAUDE.md
  learnings.md
```

## Origin: OpenClaw Agent System

This project replaces the OpenClaw-based agent workspace at PranavBakre/openclaw-agents. The older identity names are historical context, not the current Junior dispatch contract. Current public identities are `default`, `lead`, `reproducer`, `review`, and `echo`; private/org identities are loaded from `agents-org`.

- **Agent roles:** The trusted catalog includes orchestrators plus `build`, `frontend`, `architect`, `pm`, `review`, and `reproducer` capabilities. It is separate from Slack persona identities.
- **Junior's role:** Orchestrator, architect, and coordinator. It plans, reviews, and dispatches implementation work; non-trivial product edits are delegated to the appropriate trusted role.
- **Sub-agent dispatch pattern:** Share relevant conventions and past mistakes in the prompt when spawning sub-agents. They don't have memory — if you don't share it, they repeat mistakes.
- **Build -> Review loop:** Build via agent -> push -> Bones reviews -> fix -> re-review -> ship. 3-round escalation to Pranav if Bones keeps finding blockers.

What changes:
- OpenClaw's SOUL.md / AGENTS.md / TOOLS.md system is replaced by CLAUDE.md + `.claude/` config.
- Heartbeat polling is replaced by Claude Code hooks and cron.
- Agent dispatch uses Claude Code's `--resume` and worktrees in target repos instead of OpenClaw's agent workspace system.
- Agent definitions live in target repos' `.claude/agents/` — don't duplicate them in junior.

## Historical build order

The original feature-first build order is retained below as project history;
the runtime now includes additional provider, workflow, pipeline, and
reconciliation surfaces.

Features depend on each other. Build in this order:

1. **project-setup** — runtime, config, directory structure (no dependencies)
2. **slack-event-handler** — Bolt app, event filtering (depends on: config)
3. **claude-spawner** — spawn CLI, parse stream-json (depends on: config)
4. **session-management** — buffer/drain state machine (depends on: slack-event-handler, claude-spawner)
5. **stream-to-slack** — status updates from events (depends on: claude-spawner, slack-event-handler)
6. **thread-commands** — !build, !reset, !status (depends on: session-management)
7. **agent-routing** — load agent definitions, pick type (depends on: session-management, claude-spawner)
8. **worktree-manager** — target repo isolation (depends on: session-management)
9. **process-lifecycle** — timeouts, graceful shutdown, health (depends on: claude-spawner, session-management)
10. **agent-definitions** — write the .claude/agents/ markdown files (depends on: agent-routing)

Items 3-5 can partially parallelize. Items 6-9 can be built in any order once session-management is done.

## Commands

```bash
# Development
bun run dev                     # Start bot server with hot reload (--watch)
bun run start                   # Start the production entry point
bun run build                   # Build for production
bun run typecheck               # Type checking without emit
bun test                        # Run the Bun test suite

# Slack bot management
bun run cleanup                 # Delete stale idle/draining session rows
bun run migrate:prune-routing-logs # One-shot memory routing-log cleanup

# Upload files/screenshots to the current Slack thread
bin/slack-upload.sh <file-path> [comment]  # Uses SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_THREAD_TS env vars (auto-set)
```

## Documentation Workflow

After building or modifying a module:

1. **Create/update code index** — `docs/code_index/<module>.md` with file paths, key functions, data flow.
2. **Update feature doc if design changed** — update the relevant `docs/features/<name>.md`, or create a new feature doc for additions.
3. **Update this file if needed** — only if the change adds a new module, changes critical rules, or alters project structure.
