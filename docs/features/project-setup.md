# Project Setup & Configuration

## Problem

The bot needs environment configuration (Slack tokens, repo paths, timeouts) and project scaffolding (package.json, TypeScript config, directory structure) before any feature can be built. This doc covers the foundational setup.

**Who has this problem:** The first developer (Claude or human) who starts building.
**What happens today:** Empty repo with CLAUDE.md and feature docs.
**Painful part:** Getting the right TypeScript config, ESM vs CJS, which Slack SDK version, how to structure a CLI-spawning server. Wrong choices here cascade into every feature.
**"Finally" moment:** `bun run dev` starts the bot server. Hot reload works. TypeScript compiles cleanly. Slack connects. Ready to build features.

## Tech Stack

- **Runtime:** Bun (built-in TS, `.env` loading, fast child spawning, `bun:sqlite`, built-in test runner).
- **Slack SDK:** `@slack/bolt` v4 in Socket Mode — no public URL required.
- **MCP:** `@modelcontextprotocol/sdk` + `@playwright/mcp` for the bot's own MCP server and browser tooling.
- **TypeScript:** strict, ESM (`"type": "module"`).
- **Persistence:** SQLite via `bun:sqlite` (default), in-memory store for tests.
- **File locking:** `proper-lockfile` for cross-process worktree coordination.

## Entry Point

`src/index.ts` wires everything at boot, in this order:

1. `loadConfig()` — validates env, throws on missing required vars.
2. Construct `SlackApp`, `SessionStore` (factory picks sqlite/memory), `SessionManager`, `AgentRouter`, `WorktreeManager`, `DevServerManager`, `DevServerQueue`.
3. Start the internal MCP server (`startMcpServer`) so spawned Claude sessions can post back to threads.
4. Build the `AgentDispatcher` (support router) over the subset of `CHANNEL_DEFAULTS` whose default agent is `lead`.
5. Wire `SessionManager` callbacks → `SlackResponder` (`onResponse`, `onEvent`, `onMessageBuffered`, `onCommandResponse`, `onReaction`, `onError`). `prepareSlackResponse` strips the trailing `NO_SLACK_MESSAGE` sentinel; empty/sentinel-only replies are logged and suppressed.
6. Register the App Home tab and graceful-shutdown hooks.
7. Start two `setInterval` loops: orphan check (60s) and stale-session cleanup (`SESSION_CLEANUP_INTERVAL_MS`).
8. Async bootstrap: `loadOverlayIdentities("agents-org")` merges private agent identities from frontmatter (`username`, `iconEmoji`) into `AGENT_IDENTITIES`; `devServerManager.bootstrap()` prepares dev-server worktrees. Both are non-fatal.
9. `app.start()`, resolve bot identity via `auth.test`, register event handlers (every message goes through `supportRouter.handleMessage`).
10. If `config.http.enabled`, dynamic-import `./http/server.ts` and start the localhost dashboard. Failure is non-fatal — logged so the bot keeps running.

## Private Org Overlay

The private agent overlay is mounted at `agents-org/`, not under `.claude/`, because it is Junior-owned runtime data rather than a Claude Code native agent directory. Fresh clones initialize it with:

```bash
git submodule update --init agents-org
```

Existing checkouts that previously initialized `.claude/agents-org` should run:

```bash
git submodule deinit .claude/agents-org
git submodule update --init agents-org
```

The overlay is optional for public-only development. Missing `agents-org/` degrades to public agent definitions and no private identities.

## Configuration

`src/config.ts` exports `loadConfig(): Config`. Shape:

```typescript
interface Config {
  slack: { botToken; appToken; signingSecret };
  claude: {
    maxTurns;
    timeoutMs;
    permissionMode;
    defaultModel: string | null;
    defaultDriver: "headless" | "tmux"; // DEFAULT_CLAUDE_DRIVER (default: "headless")
    tmuxIdleTtlMs: number;    // TMUX_IDLE_TTL_MS (default: 14400000 — 4h)
    tmuxSweepIntervalMs: number; // TMUX_SWEEP_INTERVAL_MS (default: 900000 — 15min)
  };
  runner: { provider: "claude" | "opencode" };
  opencode: {
    model: string | null;
    timeoutMs: number;
    permission: string;
    mcpEnabled: boolean;
    slackMcpEnabled: boolean;
    playwrightMcpEnabled: boolean;
  };
  repos: RepoConfig[];                  // JSON in REPOS env var
  session: {
    staleTimeoutMs; cleanupIntervalMs;
    store: "memory" | "sqlite";
    sqlitePath; homeWindowMs;
    defaultVerbosity: "quiet" | "normal" | "verbose";
  };
  channelDefaults: Record<string, { agentType: string }>; // JSON
  adminSlackUserId: string | null;       // bootstrap admin; rest live in admins table
  http: { enabled: boolean; port: number };
}
```

`RepoConfig` carries `name`, `path`, `defaultBase`, and optional `worktreeSetupCommand`, `devCommand`, `devPort`, `readyUrl`. Repo paths have trailing slashes stripped on load.

### Env vars (see `.env.example` for the full set)

| Var | Required | Default | Notes |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | yes | — | |
| `SLACK_APP_TOKEN` | yes | — | Socket Mode `xapp-...` |
| `SLACK_SIGNING_SECRET` | no | `""` | only needed if you ever switch to Events API |
| `RUNNER_PROVIDER` | no | `opencode` | `opencode` \| `claude`; `codex` is planned but rejected until implemented |
| `CLAUDE_MAX_TURNS` | no | `25` | |
| `CLAUDE_TIMEOUT_MS` | no | `300000` | |
| `CLAUDE_MODEL` | no | unset | passed through to `claude -p --model` |
| `CLAUDE_PERMISSION_MODE` | no | `bypassPermissions` | |
| `OPENCODE_MODEL` | no | unset | passed through to `opencode run --model` |
| `OPENCODE_TIMEOUT_MS` | no | `300000` | |
| `JUNIOR_OPENCODE_PERMISSION` | no | `allow` | OpenCode permission mode in generated agent config |
| `OPENCODE_MCP_ENABLED` | no | `true` | enables generated OpenCode MCP config for normal non-utility runs |
| `OPENCODE_SLACK_MCP_ENABLED` | no | `true` | includes the local Slack MCP entry when MCP is enabled |
| `OPENCODE_PLAYWRIGHT_MCP_ENABLED` | no | `true` | includes Playwright MCP in generated OpenCode config; set `false` to disable |
| `REPOS` | no | `[]` | JSON array of `RepoConfig` |
| `CHANNEL_DEFAULTS` | no | `{"C05557KKV37":{"agentType":"lead"}}` | JSON, validated |
| `SESSION_STORE` | no | `sqlite` | `sqlite` \| `memory` |
| `SESSION_DB_PATH` | no | `data/sessions.db` | |
| `SESSION_STALE_TIMEOUT_MS` | no | `86400000` | 24h |
| `SESSION_CLEANUP_INTERVAL_MS` | no | `900000` | 15m |
| `HOME_WINDOW_MS` | no | `172800000` | App Home visibility window (2 days) |
| `SESSION_DEFAULT_VERBOSITY` | no | `normal` | `quiet` \| `normal` \| `verbose` |
| `ADMIN_SLACK_USER_ID` | no | unset | bootstrap admin; further admins live in the `admins` SQLite table |
| `HTTP_DASHBOARD_PORT` | no | unset | localhost dashboard; must be a positive integer 1–65535 or unset |
| `MCP_PORT` | no | `3456` | internal Slack-bot MCP server |

Validation rules (each throws on bad input):
- `parseRunnerProvider` — must be `claude` or `opencode`; `codex` is a planned provider and currently rejected with a not-implemented error.
- `parseStoreKind` — must be `memory` or `sqlite`.
- `parseVerbosity` — must be `quiet`/`normal`/`verbose`.
- `parseChannelDefaults` — must be a JSON object of `{channelId: {agentType: string}}`.
- `parseHttpDashboard` — unset/empty disables; otherwise must be an integer 1–65535.
- OpenCode boolean env vars accept `true`/`false`, `1`/`0`, `yes`/`no`, or `on`/`off`.

## Directory Structure

```
junior/
  src/
    index.ts              -- entry point: boot, wiring, intervals
    config.ts             -- env loading + validation
    logger.ts             -- structured logger
    persona.ts            -- bot persona loader
    slack/
      app.ts              -- Bolt app (Socket Mode)
      events.ts           -- event listeners, message routing
      commands.ts         -- thread command parsing
      formatting.ts       -- Slack formatting + NO_SLACK_MESSAGE sentinel handling
      responder.ts        -- status/response posting
      home.ts             -- App Home tab
      files.ts            -- Slack file handling
      thread-context.ts   -- prior-thread context extraction
    session/
      manager.ts          -- buffer/drain state machine
      types.ts            -- ThreadSession, verbosity types
      store/
        interface.ts      -- SessionStore interface
        factory.ts        -- createSessionStore(config)
        memory.ts         -- InMemorySessionStore
        sqlite.ts         -- SqliteSessionStore (bun:sqlite)
    claude/
      spawner.ts          -- spawn claude -p, manage child process
      args.ts             -- build CLI args from session state
      parser.ts           -- stream-json line parser
      types.ts            -- stream-json event types
    agents/
      router.ts           -- agent definition routing
      loader.ts           -- read .md files, parse frontmatter (incl. identity)
    worktree/
      manager.ts          -- create/remove/check worktrees in target repos
    support/
      router.ts           -- AgentDispatcher: per-agent persistent sessions
      agents.ts           -- overlay identity loading + per-agent context profile
    mcp/
      slack-server.ts     -- internal MCP server exposed to spawned sessions
    http/
      server.ts           -- localhost dashboard (HTTP_DASHBOARD_PORT)
      routes/             -- dashboard route handlers
    lifecycle/
      shutdown.ts         -- graceful shutdown
      health.ts           -- orphan detection
      cleanup.ts          -- stale-session cleanup
      timeout.ts          -- process timeout guard
      process-utils.ts    -- shared spawn/kill helpers
      dev-server.ts       -- per-repo dev-server manager
      dev-server-queue.ts -- single-flight dev-server activation
  .claude/
    agents/               -- public agent definitions
  agents-org/             -- private/overlay agents (identity in frontmatter)
  data/
    sessions.db           -- SQLite store (gitignored)
  docs/
    features/             -- feature docs
    code_index/           -- code indexes per module
    workflows/            -- ideation and building workflows
  .env.example
  package.json
  tsconfig.json
  CLAUDE.md
  learnings.md
```

## Commands

```bash
bun run dev         # hot-reload dev server (--watch)
bun run start       # production start
bun run typecheck   # tsc --noEmit
bun test            # bun's built-in test runner
```

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Bun only (no Node fallback) | If Bun issues arise, switch to tsx + Node |
| No production build step (run TS directly via Bun) | Post-MVP |
| No CI/CD | Post-MVP |
| JSON repo + channel config in env vars | Post-MVP (config file) |

## Cut List (true v2)

- Docker containerization
- CI/CD pipeline (GitHub Actions)
- Multi-environment config (dev/staging/prod)
- Structured logging upgrade (pino or similar)
- OpenTelemetry tracing
