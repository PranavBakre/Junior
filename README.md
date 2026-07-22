# junior

A Slack bot that acts as the control plane for coding-agent sessions. OpenCode is the default runner provider; Claude Code, OpenCode SDK, and Codex app-server are also supported. Headless CLI turns are short-lived, while Claude tmux mode is an opt-in interactive driver. Each Slack thread has durable session state and provider-native resume continuity.

Successor to the OpenClaw-based agent system at [PranavBakre/openclaw-agents](https://github.com/PranavBakre/openclaw-agents) — same role (orchestrator + sub-agent dispatcher), rebuilt on top of coding-agent CLIs.

**Stack:** Bun, TypeScript, [@slack/bolt](https://github.com/slackapi/bolt-js) (Socket Mode), provider adapters for OpenCode/Claude/Codex, SQLite persistence, dynamic markdown workflows, durable product/bug pipeline state, and on-device vector embeddings (local ONNX model — no remote embedding API).

For deep architecture and the canonical "critical rules" list, see [CLAUDE.md](./CLAUDE.md). This README is the on-ramp.

## Prerequisites

Junior orchestrates external coding agents and optional observability integrations. Install the tools required by the providers, workflows, and private `agents-org` overlay you enable:

- **[OpenCode](https://opencode.ai)** (default runner provider)
- **[Claude Code CLI](https://anthropic.com)** (Claude provider and tmux driver)
- **Vercel, New Relic, and Sentry CLIs** only if the private overlay's support agents use them
- **tmux 3.4+** (required only for `DEFAULT_CLAUDE_DRIVER=tmux`)

---

## What it does

A Slack message in a configured channel triggers one of three things:

1. **A persistent-agent dispatch** — `!review`, `!reproducer`, `!echo`, or (implicit, in support channels) `!lead`. `default`/`lead` are orchestrators; `review` and `reproducer` are core workers. `thinker` is a legacy session alias, not a current directive. Each persistent agent gets its own `sessionId`, Slack identity, and logically separate conversation in the same thread.
2. **A built-in directive** — e.g. `!devserver <branch>`, `!build`, `!status`, `!mute`. Directives are handled by junior itself or routed to a one-shot agent; they don't spawn a persistent agent.
3. **A plain message** — buffered to the active session in that thread (or starts a new one). If a turn is in progress, the message is queued and drained as a combined prompt after the current turn exits — junior never interrupts a running process.

### Multi-agent threads

A single Slack thread can host multiple agents at once. The dispatcher is in [`src/support/router.ts`](src/support/router.ts); the agent identities are in [`src/support/agents.ts`](src/support/agents.ts):

| Agent | Username | Emoji | Use |
| --- | --- | --- | --- |
| `default` | Junior | app profile | Default orchestrator for ordinary channels |
| `lead` | Junior (Lead) | :face_with_cowboy_hat: | Orchestrator marker for support channels |
| `reproducer` | Reproducer | :mag: | Reproduce a reported bug deterministically |
| `review` | Reviewer | :eyes: | Code review |
| `echo` | Echo | :speech_balloon: | Reads/writes back — used as a coordination test bed |

The trusted catalog also defines internal `pm`, `architect`, `build`, and `frontend` roles. They are selected by commands or pipeline assignments and do not need public Slack identities. See [agent routing](docs/features/agent-routing.md).

Each agent stores its own row in the `agent_sessions` SQLite table so threading can fan out without losing per-agent `--resume` continuity.

### Slack MCP server

While a runner is active, it can post to and read from Slack autonomously through an in-process HTTP MCP server ([`src/mcp/slack-server.ts`](src/mcp/slack-server.ts)). Tools exposed:

- Slack read/post/search/upload tools
- `register_worktree` — let an agent claim a worktree path mid-turn
- agent dispatch and definition search
- memory recall/add/consolidation
- pipeline start/state/assignment/outcome/check tools when pipeline mode is active
- optional MongoDB and WhatsApp read tools

The authoritative list and capability gates live in [the MCP server docs](docs/features/mcp-server.md).

This is what enables agents to talk back to other agents (or to the human) within a single turn instead of waiting for the turn to end.

### Long-term memory (v3)

Junior keeps a long-term memory in `data/memory.db` (separate from the session DB) so it accumulates knowledge across threads. The design and rationale live in [`docs/features/memory-system-v3.md`](docs/features/memory-system-v3.md); the shipped shape:

- **Capture (hot path).** Slack messages, routing decisions, and runner outputs are appended as raw **source records** by `MemoryIngestor` — cheap provenance, not yet recallable.
- **Consolidate (offline).** A `claude -p` pass reads the unconsolidated source records and derives durable memory: **episodes** (affect-tagged raw log), keyed entity **profiles** (person/repo/situation, stored as markdown under `data/profiles/`, gitignored), and atomic **claims** (lessons/facts) embedded for semantic recall. Run it via the `consolidate-v3` CLI, the `memory-consolidation` workflow, or the `memory_consolidate` MCP tool — all share `runConsolidationSweep`.
- **Recall (two surfaces).** `memory_recall` fetches keyed profiles verbatim by `entity_ref` and cosine-ranks the atomic claim store against a locally embedded query. Recall is **cosine-only** — there is no FTS channel. Optional pre-recall is off by default and must be enabled explicitly.
- **Local embeddings.** Claims and queries are embedded in-process with `onnx-community/harrier-oss-v1-270m-ONNX` (640-dim, last-token pooling), co-located with the text in SQLite as a Float32 BLOB. Nothing leaves for a remote API.
- **Decay.** Claims/episodes/profiles track `last_used_at`; an offline pass archives stale **and** low-value claims (`active = 0`, never hard-deleted). `memoryHealth` reports the fade candidates.

MCP tools: `memory_recall`, `memory_add` (add + embed one claim), `memory_consolidate`. CLI (`src/memory/cli.ts`): `consolidate-v3`, `recall-claims`, `add-claim`, `add-lesson`, `add-fact` (the `add-*` commands mirror into the claim store so new lessons/facts are immediately recallable).

The legacy associative-memory layer (event/edge graph, FTS, candidate-rule learning) has been retired; `src/memory/migrate-v3.ts` was the one-shot migration that folded the old `lesson`/`memory_fact` rows into claims and dropped the condemned tables.

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

Sessions, per-agent sessions, action records, workflow state, and pipeline state use SQLite stores under `data/` (`bun:sqlite`, single-writer). Each store creates or extends its tables on boot; there is no standalone migration CLI for session/workflow/pipeline state. `SESSION_STORE=memory` switches the session/workflow/pipeline stores to in-memory implementations for tests.

### Slack home tab

Per-user view of recent threads, mute state, and last activity. Window is `HOME_WINDOW_MS` (default 48h). Code: [`src/slack/home.ts`](src/slack/home.ts).

### HTTP dashboard

Localhost-only HTTP dashboard for live introspection — threads, per-agent sessions, dev-server queue depth, recent logs.

**Off by default.** Enable by setting `HTTP_DASHBOARD_PORT`:

```sh
HTTP_DASHBOARD_PORT=8787 bun run dev
# open http://127.0.0.1:8787
```

Binds `127.0.0.1` only. Junior is intentionally insecure as a networked product: there is no dashboard auth, and it assumes a trusted local operator. Do not put it behind a reverse proxy without adding auth and a real security review.

| Path | Description |
| --- | --- |
| `GET /` | Static dashboard (`public/index.html`) |
| `GET /api/health` | Uptime + session/agent totals |
| `GET /api/sessions` | All threads with their agent sessions |
| `GET /api/sessions/:threadId` | Full session detail |
| `GET /api/dev-server` | Per-repo manager state + queue depth |
| `GET /api/workflows` | Loaded workflow definitions, runtime state, and recent runs |
| `GET /api/logs?date=&tail=&tag=&level=` | Tail of structured logs |
| `GET /api/memory` / `GET /api/memory/<path>` | Browse `docs/**/*.md` |
| `GET /api/memory/recall` | Read-only claim/profile recall for the dashboard |
| `GET /api/memory/projection` | Read-only memory-cloud projection data |

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
| `RUNNER_PROVIDER` | `opencode` | Default runner provider: `opencode`, `opencode-sdk`, `codex-app-server`, or `claude` |
| `CLAUDE_MAX_TURNS` | `100` | Max turns per `claude -p` / `claude -p --resume` invocation |
| `CLAUDE_TIMEOUT_MS` | `300000` | Per-turn timeout before SIGINT |
| `CLAUDE_MODEL` | *(unset)* | Override default Claude model |
| `OPENCODE_MODEL` | *(unset)* | Override default OpenCode model |
| `OPENCODE_TIMEOUT_MS` | `300000` | Per-turn OpenCode timeout before SIGINT |
| `OPENCODE_CONTINUITY_ENABLED` | `false` | Enables OpenCode session reuse across completed turns: CLI `--session` / SDK reattach. SDK provider kill still uses OpenCode native abort; CLI interrupt-and-resume is not verified. |
| `JUNIOR_OPENCODE_PERMISSION` | `allow` | OpenCode permission mode for generated agent config |
| `OPENCODE_MCP_ENABLED` | `true` | Enables generated OpenCode MCP config for normal non-utility runs |
| `OPENCODE_PLAYWRIGHT_MCP_ENABLED` | `true` | Include Playwright MCP in generated OpenCode config; set `false` to disable |
| `OPENCODE_SLACK_MCP_ENABLED` | `true` | Include Slack MCP in generated OpenCode config |
| `OPENCODE_MIXPANEL_MCP_ENABLED` | `true` | Include Mixpanel MCP when configured |
| `OPENCODE_MONGODB_MCP_ENABLED` | `true` | Include MongoDB MCP when configured |
| `CODEX_MODE` | `app-server` | Codex transport: `app-server` or the isolated `cli` fallback |
| `CODEX_MODEL` | *(unset)* | Override default Codex app-server model |
| `CODEX_TIMEOUT_MS` | `300000` | Per-turn Codex timeout before SIGINT |
| `CODEX_SANDBOX` | `workspace-write` | Codex app-server sandbox. Set `danger-full-access` for YOLO-style full filesystem/network access. |
| `CODEX_ASK_FOR_APPROVAL` | `never` | Codex app-server approval policy |
| `CODEX_APP_SERVER_CONTINUITY_ENABLED` | `false` | Enables Codex app-server idle-timeout recovery: native `turn/interrupt` plus automatic continue turn. Normal `thread/resume` across app restarts stays enabled. |
| `CODEX_ISOLATED_HOME_PATH` | `data/codex-home` | Junior-owned Codex home with generated config and symlinked auth |
| `PRE_RECALL_ENABLED` | `false` | Run the optional cheap-model recall query extractor before runner turns |
| `WHATSAPP_ENABLED` | `false` | Enable the read-only WhatsApp archive and MCP tools |
| `PIPELINE_RUNTIME_MODE` | `off` | Durable pipeline mode: `off`, `shadow`, or `active` |
| `BUG_PIPELINE_ENABLED` / `PRODUCT_PIPELINE_ENABLED` | `false` | Enable typed bug/product starts; requires `PIPELINE_RUNTIME_MODE=active` |
| `GITHUB_RECONCILE_ENABLED` | `false` | Enable outbound PR/resource reconciliation |

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
!pm [prompt]               -- spawn the PM one-shot agent
!review                    -- dispatch to the review persistent agent
!reproducer                -- dispatch to the reproducer persistent agent
!echo / !lead              -- ditto

!cancel                    -- cancel the in-flight turn
!reset                     -- drop session + worktree state for this thread
!clear                     -- archive thread and delete Junior bot messages (admin)
!status                    -- show this thread's session state
!repo <name>               -- pin this thread to a target repo
!branch <name>             -- pin this thread to a base ref
!provider <name>           -- switch this thread's runner provider
!quiet | !normal | !verbose -- per-thread verbosity
!mute | !unmute            -- silence/unsilence this thread
!aside [text]              -- discard one message without waking a runner
!listen                    -- wake an auto-dormant thread
!adhoc / !bugs / !help     -- channel-specific entry points

!workflow <show|run|start|stop|logs|reload> [name]
!workflows                 -- list workflow definitions and state

!devserver <branch> [repo] -- acquire dev-server slot
!devserver status          -- queue depth
!devserver kill <repo>     -- drop slot

!driver <headless|tmux>    -- switch driver (tmux is EXPERIMENTAL)
```

### Experimental: TMUX Mode

Junior supports an experimental "Interactive Driver" that runs Claude Code inside a persistent `tmux` session. The implementation is present behind a flag and still needs production soak before becoming the default.

To try it:
- Set `DEFAULT_CLAUDE_DRIVER=tmux` in your `.env`.
- Ensure `tmux` version ≥ 3.4 is installed.

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
                    claude -p / opencode run / Codex app-server
                    (per-thread provider)
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
  runners/              provider selection, shared runtime contract
  opencode/             OpenCode args, config, parser, spawner
  claude/               Claude headless spawner, tmux driver, parsers
  worktree/             per-(repo, thread) worktree manager
  agents/               agent loader (.md frontmatter)
  support/              AgentDispatcher, persistent-agent identities
  lifecycle/            dev-server manager + queue, timeouts, shutdown, health
  mcp/                  in-process Slack/MongoDB/WhatsApp MCP server + approvals
  pipelines/             durable product/bug runs, assignments, outcomes, outbox
  github/                read-only PR/resource reconciliation
  workflows/             markdown workflow registry, scheduler, executor, store
  time/                  injectable clock seams for durable state tests
  http/                  localhost dashboard
public/                 static dashboard assets
docs/                   feature design docs, code indexes, workflows
```

For per-feature deep dives and source maps, start with [`docs/README.md`](docs/README.md), then use `docs/features/<name>.md` and `docs/code_index/<name>.md`.

---

## Running tests + typecheck

```sh
bun run dev         # start bot server with hot reload
bun run typecheck   # tsc --noEmit
bun test            # bun:test
bun run build       # build for production
bun run cleanup     # delete stale idle/draining session rows
```

---

## Origin and naming

Junior is the orchestrator in a Star-Trek-named agent squad. The current public runtime uses `default`/`lead`, `reproducer`, and `review`; private overlays may add organization-specific identities. Agent dispatch is shared-context — agents don't have memory across runs, so the dispatcher passes relevant conventions and prior mistakes in the prompt. See the "Origin: OpenClaw Agent System" section in [CLAUDE.md](./CLAUDE.md) for historical context.
