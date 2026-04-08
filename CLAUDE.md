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
| Full system design, architecture, trade-offs? | [docs/features/main.md](docs/features/main.md) |
| How session management works (buffer, batch, drain)? | [docs/features/main.md](docs/features/main.md) — "Buffering over interruption" |
| Worktree isolation design? | [docs/features/main.md](docs/features/main.md) — "Worktree Isolation" |
| MCP and skill isolation per thread? | [docs/features/main.md](docs/features/main.md) — "Skill & MCP Isolation" |
| Streaming and status updates? | [docs/features/main.md](docs/features/main.md) — "Streaming Updates to Slack" |
| Known limitations and open questions? | [docs/features/main.md](docs/features/main.md) — bottom sections |
| Code index for a specific module? | `docs/code_index/<module>.md` (created as modules are built) |

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
5. **Worktree per thread.** Each Slack thread gets its own git worktree via `--worktree "slack-<threadId>"`. This isolates file edits across concurrent sessions.
6. **Stream events for status.** Parse `--output-format stream-json` events (tool_use, text, result) and post incremental Slack updates. The final `result` event is the response to post.
7. **Session state is authoritative.** The session map (thread_id -> session) is the single source of truth for whether a thread is idle/busy, what its session ID is, and what messages are pending.
8. **Cleanup stale threads.** Worktrees and sessions for inactive threads (24h default) must be cleaned up. Check for uncommitted changes before force-removing a worktree.
9. **MCP config is per-thread.** Pass `--mcp-config <path>` to scope each thread's available tools. Global MCP servers are NOT loaded when this flag is present.
10. **No `--input-format stream-json` in production.** The bidirectional streaming flag exists but is undocumented and unstable. Use `--resume` for multi-turn until the protocol is specified.
11. **Redis for production persistence.** In-memory Map is fine for MVP. Production needs Redis with TTL-based session storage to survive restarts. Pending messages don't need persistence — if the bot restarts, the Claude process dies with it.
12. **Always handle zombie processes.** Set a timeout guard (5 min default). Kill with SIGINT on timeout. Handle process errors. Clear the timeout on exit.
13. **Design for swappability.** When adding infrastructure that could have multiple implementations (persistence, message queue, notification), use a provider/factory pattern. Each provider gets its own file, a factory selects the right one.
14. **Pure functions over framework ceremony.** If a library's core value is bypassed, replace it with the simplest implementation. A 20-line function beats a dependency you're working around.
15. **Test against real infrastructure, mock at boundaries.** Mock Slack API and Claude CLI at system boundaries. Don't mock internal session management or message routing.

## Project Structure

```
junior/
  docs/
    features/       -- feature design docs (RFC, specs)
      main.md       -- core Slack bot -> Claude Code orchestrator design
    code_index/     -- code indexes per module (created as code is built)
  src/              -- source code (to be created)
  CLAUDE.md         -- this file
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
- Agent dispatch uses Claude Code's `--worktree` and `--resume` instead of OpenClaw's agent workspace system.

## Commands

```bash
# Development (to be defined as code is built)
# npm run dev                   -- Start bot server with hot reload
# npm run build                 -- Build for production
# npm test                      -- Run tests

# Slack bot management (to be defined)
# npm run cleanup               -- Clean stale worktrees and sessions
```

## Documentation Workflow

After building or modifying a module:

1. **Create/update code index** — `docs/code_index/<module>.md` with file paths, key functions, data flow.
2. **Update feature doc if design changed** — `docs/features/main.md` or create a new feature doc for additions.
3. **Update this file if needed** — only if the change adds a new module, changes critical rules, or alters project structure.
