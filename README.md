# junior

A Slack bot that acts as the control plane for headless coding-agent sessions. OpenCode is the default runner provider; Claude Code remains available as a fallback provider. Each Slack thread maps to its own short-lived runner subprocess, and continuity comes from the provider's native resume session ID rather than a long-lived process.

Successor to the OpenClaw-based agent system at [PranavBakre/openclaw-agents](https://github.com/PranavBakre/openclaw-agents) — same role (orchestrator + sub-agent dispatcher), rebuilt on top of coding-agent CLIs.

**Stack:** Bun, TypeScript, [@slack/bolt](https://github.com/slackapi/bolt-js) (Socket Mode), OpenCode by default with Claude Code as an alternate provider, SQLite for session persistence.

For deep architecture and the canonical "critical rules" list, see [CLAUDE.md](./CLAUDE.md). This README is the on-ramp.

---

## What it does

A Slack message in a configured channel triggers one of three things:

1. **A persistent-agent dispatch** — `!review`, `!reproducer`, `!thinker`, `!echo`, or (implicit, in support channels) `!lead`. Each persistent agent gets its own `sessionId`, its own Slack username + emoji, and runs as a logically separate Claude conversation in the same thread.
2. **A built-in directive** — e.g. `!devserver <branch>`, `!build`, `!status`, `!mute`. Directives are handled by junior itself or routed to a one-shot agent; they don't spawn a persistent agent.
3. **A plain message** — buffered to the active session in that thread (or starts a new one). If a turn is in progress, the message is queued and drained as a combined prompt after the current turn exits — junior never interrupts a running process.

### Multi-agent threads

A single Slack thread can host multiple agents at once. The dispatcher is in [`src/support/router.ts`](src/support/router.ts); the agent identities are in [`src/support/agents.ts`](src/support/agents.ts):

| Agent | Username | Emoji | Use |
| --- | --- | --- | --- |
| `lead` | Junior | :face_with_cowboy_hat: | Default in support channels — orchestrator / rubber duck |
| `reproducer` | Reproducer | :mag: | Reproduce a reported bug deterministically |
| `thinker` | Thinker | :wrench: | Form and mock-test a hypothesis |
| `review` | Reviewer | :eyes: | Code review |
| `echo` | Echo | :speech_balloon: | Reads/writes back — used as a coordination test bed |

Each agent stores its own row in the `agent_sessions` SQLite table so threading can fan out without losing per-agent `--resume` continuity.

### Slack MCP server

While Claude is running, it can post to and read from Slack autonomously through an in-process HTTP MCP server ([`src/mcp/slack-server.ts`](src/mcp/slack-server.ts)). Tools exposed:

- `slack_send_message`, `slack_read_channel`, `slack_read_thread`
- `slack_search`, `slack_search_users`
- `slack_upload_file`
- `register_worktree` — let an agent claim a worktree path mid-turn

This is what enables agents to talk back to other agents (or to the human) within a single turn instead of waiting for the turn to end.

### Dev-server queue

For repos with `devCommand` configured, junior owns the lifecycle of a single shared dev server per repo. Concurrent acquires across threads serialize on a `proper-lockfile` per-repo lock, with a 10-minute slot timeout and a 20-minute idle TTL (kills the server if no one re-acquires).

- `!devserver <branch>` — acquire the slot for all dev-configured repos in the thread
- `!devserver <branch> <repo>` — acquire for one repo
- `!devserver status` — show holder + waiters per repo
- `!devserver kill <repo>` — drop the slot

Implementation: [`src/lifecycle/dev-server.ts`](src/lifecycle/dev-server.ts), [`src/lifecycle/dev-server-queue.ts`](src/lifecycle/dev-server-queue.ts).

### Worktrees per (repo, thread)

Each thread that touches a target repo gets its own git worktree at `<repo>.junior-worktrees/slack-<threadId>` (sibling to the repo, deliberately outside `.claude/` so target-repo setup scripts that recursively copy `.claude/` don't pull every sibling thread's source tree into a fresh worktree). A thread can have worktrees in multiple repos at once (full-stack bug → backend + frontend). See [`src/worktree/manager.ts`](src/worktree/manager.ts) and the `worktreePaths` field on `ThreadSession`.

### SQLite persistence

Sessions and per-agent sessions persist in `data/sessions.db` (`bun:sqlite`, single-writer). The schema is created on boot — no migration tooling needed yet. `SESSION_STORE=memory` switches to the in-memory store for tests.

### Slack home tab

Per-user view of recent threads, mute state, and last activity. Window is `HOME_WINDOW_MS` (default 48h). Code: [`src/slack/home.ts`](src/slack/home.ts).

### HTTP dashboard

Localhost-only HTTP dashboard for live introspection — threads, per-agent sessions, dev-server queue depth, recent logs.

**Off by default.** Enable by setting `HTTP_DASHBOARD_PORT`:

```sh
HTTP_DASHBOARD_PORT=8787 bun run dev
# open http://127.0.0.1:8787
```

Binds `127.0.0.1` only — there is no auth. Do not put it behind a reverse proxy without adding one.

| Path | Description |
| --- | --- |
| `GET /` | Static dashboard (`public/index.html`) |
| `GET /api/health` | Uptime + session/agent totals |
| `GET /api/sessions` | All threads with their agent sessions |
| `GET /api/sessions/:threadId` | Full session detail |
| `GET /api/dev-server` | Per-repo manager state + queue depth |
| `GET /api/logs?date=&tail=&tag=&level=` | Tail of structured logs |
| `GET /api/memory` / `GET /api/memory/<path>` | Browse `docs/**/*.md` |

Ported from [Friday](https://github.com/anmolm-growthx/Friday)'s `src/http/`. Junior-specific extensions: `/api/dev-server` exposes `DevServerQueue` state, and `/api/sessions` joins `agent_sessions` so the UI can render multi-agent threads.

---

## Quickstart

```sh
bun install
cp .env.example .env  # if you have one — otherwise see "Configuration" below
bun run dev
```

Junior connects to Slack over Socket Mode, so no public ingress is needed. You'll need a Slack app with:
- Bot token (`SLACK_BOT_TOKEN`, starts with `xoxb-`)
- App-level token with `connections:write` (`SLACK_APP_TOKEN`, starts with `xapp-`)
- Subscriptions to `message.channels` and `app_mention`

Then add the bot to a channel and message it.

---

## Configuration

All config is loaded from environment variables in [`src/config.ts`](src/config.ts). The most useful knobs:

| Env var | Default | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | *(required)* | `xoxb-…` bot token |
| `SLACK_APP_TOKEN` | *(required)* | `xapp-…` app token for Socket Mode |
| `REPOS` | `[]` | JSON array of `RepoConfig` (see below) |
| `CHANNEL_DEFAULTS` | `{"C05557KKV37":{"agentType":"lead"}}` | Per-channel default agent type. Channels with `agentType:"lead"` go through the support router (multi-agent dispatcher) |
| `SESSION_STORE` | `sqlite` | `sqlite` or `memory` |
| `SESSION_DB_PATH` | `data/sessions.db` | SQLite file path |
| `HTTP_DASHBOARD_PORT` | *(unset)* | If set, starts the localhost dashboard |
| `MCP_PORT` | `3456` | Port for the in-process Slack MCP server |
| `RUNNER_PROVIDER` | `opencode` | Default runner provider: `opencode` or `claude` (codex is planned but not yet implemented) |
| `CLAUDE_MAX_TURNS` | `25` | Max turns per `claude -p` invocation |
| `CLAUDE_TIMEOUT_MS` | `300000` | Per-turn timeout before SIGINT |
| `CLAUDE_MODEL` | *(unset)* | Override default Claude model |
| `OPENCODE_MODEL` | *(unset)* | Override default OpenCode model |
| `OPENCODE_TIMEOUT_MS` | `300000` | Per-turn OpenCode timeout before SIGINT |
| `JUNIOR_OPENCODE_PERMISSION` | `allow` | OpenCode permission mode for generated agent config |
| `OPENCODE_MCP_ENABLED` | `true` | Enables generated OpenCode MCP config for worktree-backed runs |
| `OPENCODE_PLAYWRIGHT_MCP_ENABLED` | `false` | Opt in to Playwright MCP for OpenCode worktree-backed runs |

`REPOS` example:

```json
[
  {
    "name": "example-backend",
    "path": "/Users/you/code/example-backend",
    "defaultBase": "main",
    "devCommand": "pnpm dev",
    "devPort": 3000
  }
]
```

See [`src/config.ts`](src/config.ts) for the full set including `worktreeSetupCommand`, `readyUrl`, verbosity, cleanup intervals, etc.

---

## Commands and directives

Slash-style commands are parsed in [`src/slack/commands.ts`](src/slack/commands.ts). Persistent-agent directives are parsed in [`src/support/router.ts`](src/support/router.ts).

```
!build [prompt]            -- spawn the build one-shot agent
!frontend [prompt]         -- spawn the frontend one-shot agent
!architect [prompt]        -- spawn the architect one-shot agent
!review                    -- dispatch to the review persistent agent
!reproducer / !thinker     -- ditto
!echo / !lead              -- ditto

!cancel                    -- cancel the in-flight turn
!reset                     -- drop session + worktree state for this thread
!status                    -- show this thread's session state
!repo <name>               -- pin this thread to a target repo
!branch <name>             -- pin this thread to a base ref
!provider <name>           -- switch this thread's runner provider
!quiet | !normal | !verbose -- per-thread verbosity
!mute | !unmute            -- silence/unsilence this thread
!adhoc / !bugs / !help     -- channel-specific entry points

!devserver <branch> [repo] -- acquire dev-server slot
!devserver status          -- queue depth
!devserver kill <repo>     -- drop slot
```

---

## Architecture at a glance

```
Slack Event API (message.channels, app_mention)
    |
    v
Bolt Socket Mode (src/slack/app.ts, events.ts)
    |
    v
AgentDispatcher (src/support/router.ts)
    |
    +-- !devserver  -> DevServerQueue.acquire() -> DevServerManager
    +-- !<agent>    -> SessionManager.handleAgentMessage(agentName)
    +-- (default)   -> SessionManager.handleLeadMessage / handleMessage
                          |
                          v
                  Spawn runner provider
                    claude -p / opencode run      (per-thread provider)
                    native resume id              (continuity)
                    normalized runner events      (tool/text/result events)
                    project MCP config            (worktree-backed runs)
                    cwd = worktree per (repo, thread)
                          |
                          v
                  Stream events  -> SlackResponder (status pills, final post)
                  agent_sessions <- per-agent sessionId persistence
```

Three invariants that the rest of the code hangs off (see [CLAUDE.md](./CLAUDE.md) for the full list):

1. **One runner process per turn.** Spawn → respond → exit. No long-lived processes between messages.
2. **Native resume for continuity.** Session IDs are extracted from provider events and cached with their provider.
3. **Buffer, don't interrupt.** Messages arriving during a turn are queued and drained as a combined prompt afterwards.

---

## Project structure

```
src/
  index.ts              entry point — wires everything
  config.ts             env loading, RepoConfig
  slack/                Bolt app, event handlers, formatting, home tab
  session/              ThreadSession, SessionManager, SQLite + memory stores
  claude/               spawner, args, stream-json parser
  worktree/             per-(repo, thread) worktree manager
  agents/               agent loader (.md frontmatter)
  support/              AgentDispatcher, persistent-agent identities
  lifecycle/            dev-server manager + queue, timeouts, shutdown, health
  mcp/                  in-process Slack MCP server
  http/                 localhost dashboard (this PR)
public/                 static dashboard assets
docs/                   feature design docs, code indexes, workflows
```

For per-feature deep dives, see the [`docs/`](docs/) tree — `docs/architecture.md` and `docs/features/<name>.md`.

---

## Running tests + typecheck

```sh
bun run typecheck   # tsc --noEmit
bun test            # bun:test
bun run cleanup     # remove stale worktrees + sessions
```

---

## Origin and naming

Junior is the orchestrator in a Star-Trek-named agent squad: Scotty (backend), Uhura (frontend), Bones (reviewer). Sub-agent dispatch is shared-context — agents don't have memory across runs, so the dispatcher passes relevant conventions and prior mistakes in the prompt. See the "Origin: OpenClaw Agent System" section in [CLAUDE.md](./CLAUDE.md) for what carried over from the previous incarnation and what changed.
