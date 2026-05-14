# CLAUDE.md — junior

## Project Overview

junior is a Slack bot that acts as the control plane for Claude Code sessions. It's the successor to the OpenClaw-based agent system (PranavBakre/openclaw-agents) — same role (Junior the orchestrator), rebuilt on Claude Code as a subprocess instead of OpenClaw.

The server owns the lifecycle. When a Slack message arrives in a thread, the bot either spawns a new Claude Code CLI process or routes the message to an existing session. Each thread gets its own isolated session with its own worktree, skills, and MCP config.

**Stack:** Node.js / Bun, TypeScript, Slack Event API, Claude Code CLI (Max subscription auth)

**Key architectural choice:** CLI subprocess (`claude -p`), not SDK. The CLI authenticates via Max subscription — no API keys, no usage-based billing. Each Slack message spawns a short-lived process; `--resume` picks up conversation context from the last completed turn.

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
| How does the bot Slack MCP server work? | [docs/features/mcp-server.md](docs/features/mcp-server.md) |
| Headless vs tmux driver, why two paths exist, how tmux runs the TUI? | [docs/features/interactive-driver.md](docs/features/interactive-driver.md) |
| Project setup, config, directory structure? | [docs/features/project-setup.md](docs/features/project-setup.md) |
| Known limitations and open questions? | [docs/features/v2-backlog.md](docs/features/v2-backlog.md) |
| Code index for a specific module? | `docs/code_index/<module>.md` (matches feature doc names) |
| Ideation and planning workflow? | [docs/workflows/ideation.md](docs/workflows/ideation.md) |
| Building and iteration workflow? | [docs/workflows/building.md](docs/workflows/building.md) |

## Architecture

```
Slack Event API (message.channels, app_mention)
    |
    v
Slack Bot Server (Node.js / Bun)
    |
    +-- Session Manager: Map<thread_id, session>
    |     session = { sessionId, worktreePath, status, pendingMessages, skillSet }
    |
    +-- On message:
    |     1. Look up thread_id
    |     2. If busy -> buffer message (react with eyes)
    |     3. If idle -> spawn claude -p with --resume, --worktree, --output-format stream-json
    |     4. On exit -> post response to Slack, drain buffer
    |
    +-- Claude Code CLI Process (short-lived, one per message turn)
          claude -p "<prompt>" --resume <session_id> --worktree "slack-<threadId>"
            --output-format stream-json --mcp-config <per-thread> --max-turns 25
```

## Critical Rules

1. **CLI subprocess, not SDK.** Spawn `claude -p` as a child process. Authenticate via Max subscription. Never use `@anthropic-ai/claude-code` as a library — that requires API keys.
2. **One process per message turn.** Each Slack message spawns a short-lived `claude -p` process. The process exits after responding. No long-lived processes between messages.
3. **`--resume` for continuity.** Use `--resume <sessionId>` to pick up conversation context. Session IDs are extracted from the first `stream-json` event on stdout.
4. **Buffer, don't interrupt.** If Claude is mid-execution and new messages arrive, buffer them. Never kill a running process — it risks corrupted session state. Drain the buffer as a combined prompt after the current turn exits.
5. **Worktrees for target repos only.** Junior's workspace is shared across all threads (learnings accumulate). Worktrees are created in TARGET repos (example-backend, example-frontend) when threads need code isolation. Threads that only read or discuss don't need worktrees.
6. **Stream events for status.** Parse `--output-format stream-json` events (tool_use, text, result) and post incremental Slack updates. The final `result` event is the response to post.
7. **Session state is authoritative.** The session map (thread_id -> session) is the single source of truth for whether a thread is idle/busy, what its session ID is, and what messages are pending.
8. **Cleanup stale threads.** Worktrees and sessions for inactive threads (24h default) must be cleaned up. Check for uncommitted changes before force-removing a worktree.
9. **MCP config is per-thread.** Pass `--mcp-config <path>` to scope each thread's available tools. Global MCP servers are NOT loaded when this flag is present.
10. **No `--input-format stream-json` in production.** The bidirectional streaming flag exists but is undocumented and unstable. Use `--resume` for multi-turn until the protocol is specified.
11. **SQLite for persistence.** Sessions persist in a SQLite file via `bun:sqlite` (`data/sessions.db` by default, `SESSION_DB_PATH` to override). Single-writer, no extra service, survives restarts. `SESSION_STORE=memory` switches to the in-memory store for tests/dev. The home tab shows only sessions active in the last `HOME_WINDOW_MS` (2 days default); cleanup and health still scan all rows. Pending messages are persisted but treated as stale on restart — the Claude process they were queued behind is dead.
12. **Always handle zombie processes.** Set a timeout guard (5 min default). Kill with SIGINT on timeout. Handle process errors. Clear the timeout on exit.
13. **Design for swappability.** When adding infrastructure that could have multiple implementations (persistence, message queue, notification), use a provider/factory pattern. Each provider gets its own file, a factory selects the right one.
14. **Pure functions over framework ceremony.** If a library's core value is bypassed, replace it with the simplest implementation. A 20-line function beats a dependency you're working around.
15. **Test against real infrastructure, mock at boundaries.** Mock Slack API and Claude CLI at system boundaries. Don't mock internal session management or message routing.

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
    claude/
      spawner.ts          -- spawn claude -p, manage child process
      args.ts             -- build CLI args from session state
      parser.ts           -- stream-json line parser
      types.ts            -- stream-json event types
    worktree/
      manager.ts          -- create/remove/check worktrees in target repos
      types.ts            -- RepoConfig
    agents/
      router.ts           -- load agent definitions, pick agent type
      loader.ts           -- read .md files, parse frontmatter
    lifecycle/
      timeout.ts          -- process timeout guard
      health.ts           -- orphan detection
      shutdown.ts         -- graceful bot shutdown
  .claude/
    agents/               -- agent definitions (junior's own, not target repo's)
      common/
        building-philosophy.md
      build.md
      review.md
      frontend.md
      architect.md
      pm.md
  docs/
    features/             -- feature design docs with iteration plans
    code_index/           -- code indexes per module
    workflows/            -- ideation and building workflows
  CLAUDE.md
  learnings.md
```

## Origin: OpenClaw Agent System

This project replaces the OpenClaw-based agent workspace at PranavBakre/openclaw-agents. Key things that carry over:

- **Agent squad:** Junior (orchestrator), Scotty (backend builder), Uhura (frontend builder), Bones (code reviewer) — Star Trek naming.
- **Junior's role:** Architect, orchestrator, rubber duck. Plans, reviews, coordinates — agents code. Does not write production code directly for non-trivial work.
- **Sub-agent dispatch pattern:** Share relevant conventions and past mistakes in the prompt when spawning sub-agents. They don't have memory — if you don't share it, they repeat mistakes.
- **Build -> Review loop:** Build via agent -> push -> Bones reviews -> fix -> re-review -> ship. 3-round escalation to Pranav if Bones keeps finding blockers.

What changes:
- OpenClaw's SOUL.md / AGENTS.md / TOOLS.md system is replaced by CLAUDE.md + `.claude/` config.
- Heartbeat polling is replaced by Claude Code hooks and cron.
- Agent dispatch uses Claude Code's `--resume` and worktrees in target repos instead of OpenClaw's agent workspace system.
- Agent definitions live in target repos' `.claude/agents/` — don't duplicate them in junior.

## Build Order

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
bun run build                   # Build for production
bun run typecheck               # Type checking without emit

# Slack bot management
bun run cleanup                 # Clean stale worktrees and sessions

# Upload files/screenshots to the current Slack thread
bin/slack-upload.sh <file-path> [comment]  # Uses SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_THREAD_TS env vars (auto-set)
```

## Documentation Workflow

After building or modifying a module:

1. **Create/update code index** — `docs/code_index/<module>.md` with file paths, key functions, data flow.
2. **Update feature doc if design changed** — `docs/features/main.md` or create a new feature doc for additions.
3. **Update this file if needed** — only if the change adds a new module, changes critical rules, or alters project structure.
