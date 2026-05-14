# Project Setup & Configuration

## Problem

The bot needs environment configuration (Slack tokens, repo paths, timeouts) and project scaffolding (package.json, TypeScript config, directory structure) before any feature can be built. This doc covers the foundational setup.

**Who has this problem:** The first developer (Claude or human) who starts building.
**What happens today:** Empty repo with CLAUDE.md and feature docs.
**Painful part:** Getting the right TypeScript config, ESM vs CJS, which Slack SDK version, how to structure a CLI-spawning server. Wrong choices here cascade into every feature.
**"Finally" moment:** `npm run dev` starts the bot server. Hot reload works. TypeScript compiles cleanly. Slack connects. Ready to build features.

## Full Vision

- Node.js or Bun runtime (decision needed)
- TypeScript with strict mode
- ESM modules
- Slack Bolt SDK with Socket Mode
- Environment variables via `.env` file (not committed)
- Directory structure matching the feature boundaries
- Dev server with hot reload
- Build step for production

## Tech Stack Decisions

### Runtime: Bun

Bun over Node for this project:
- Built-in TypeScript (no tsc compile step for dev)
- Built-in .env loading (no dotenv)
- Faster child process spawning (matters — we spawn a lot)
- Built-in test runner
- Single binary, simpler deployment

Fallback to Node if Bun has issues with Slack Bolt or child_process edge cases.

### Slack SDK: @slack/bolt

Bolt is Slack's official framework. Socket Mode means no public URL needed — works from behind a firewall, on a laptop, anywhere.

### Package Manager: bun

If using Bun runtime, use its built-in package manager.

## Configuration

```typescript
// src/config.ts
interface Config {
  slack: {
    botToken: string; // SLACK_BOT_TOKEN
    appToken: string; // SLACK_APP_TOKEN
    signingSecret: string; // SLACK_SIGNING_SECRET
  };
  claude: {
    maxTurns: number; // CLAUDE_MAX_TURNS (default: 25)
    timeoutMs: number; // CLAUDE_TIMEOUT_MS (default: 300000)
    permissionMode: string; // CLAUDE_PERMISSION_MODE (default: "bypassPermissions")
  };
  repos: Array<{
    name: string;
    path: string;
    defaultBase: string;
  }>;
  session: {
    staleTimeoutMs: number; // SESSION_STALE_TIMEOUT_MS (default: 86400000)
    cleanupIntervalMs: number; // SESSION_CLEANUP_INTERVAL_MS (default: 900000)
  };
  // Bootstrap admin Slack user ID. Additional admins live in the `admins`
  // table in the session DB (added via direct SQL — see thread-commands.md).
  // Gate is open only when env is unset AND the admins table is empty.
  adminSlackUserId: string | null; // ADMIN_SLACK_USER_ID
  redis?: {
    url: string; // REDIS_URL (optional — in-memory if not set)
  };
}
```

## Directory Structure

```
junior/
  src/
    index.ts              -- entry point: start Slack app, wire everything
    config.ts             -- env loading, config validation
    slack/
      app.ts              -- Bolt app setup, Socket Mode
      events.ts           -- event listeners, message routing
      commands.ts         -- slash command parsing
      formatting.ts       -- Slack message formatting, block kit
    session/
      manager.ts          -- session manager (state machine, buffer/drain)
      types.ts            -- ThreadSession interface, event types
      store/
        interface.ts      -- SessionStore interface
        memory.ts         -- InMemorySessionStore
        redis.ts          -- RedisSessionStore (production)
    claude/
      spawner.ts          -- spawn claude -p, manage child process
      args.ts             -- build CLI args from session state
      parser.ts           -- stream-json line parser
      types.ts            -- event types for stream-json
    worktree/
      manager.ts          -- create/remove/check worktrees
      types.ts            -- RepoConfig, worktree state
    agents/
      router.ts           -- load agent definitions, pick agent type
      loader.ts           -- read .md files, parse frontmatter
    lifecycle/
      timeout.ts          -- process timeout guard
      health.ts           -- orphan detection, health check
      shutdown.ts         -- graceful bot shutdown
  .claude/
    agents/               -- agent definitions for this project
      common/
        building-philosophy.md
      build.md
      review.md
      frontend.md
      architect.md
      pm.md
  docs/
    features/             -- feature docs (this directory)
    code_index/           -- code indexes per module
    workflows/            -- ideation and building workflows
  .env.example            -- required env vars (no values)
  package.json
  tsconfig.json
  CLAUDE.md
  learnings.md
```

## Iterations

### Iteration 0: Hello world (~15 min)

Prove Bun + Bolt + Socket Mode works.

**What it adds:**
- `package.json` with `@slack/bolt` dependency
- `tsconfig.json` with strict mode, ESM
- `src/index.ts` — Bolt app with Socket Mode, single `message` event listener that echoes
- `.env.example` with required Slack tokens
- `bun run dev` script

**Test:** `bun run dev` → bot connects to Slack. Send message mentioning bot → bot echoes in thread.
**Defers:** Everything except "it connects and responds."

### Iteration 1: Directory structure and config (~20 min)

**What it adds:**
- Full directory structure (empty files with type exports)
- `src/config.ts` — load and validate environment variables
- Config validation: fail fast on missing required vars
- Repo config from env (JSON string or individual vars)

**Test:** Missing `SLACK_BOT_TOKEN` → clear error message on startup. All vars present → config loads cleanly. `import { config } from './config'` works from any module.
**Defers:** Feature code (just structure and config).

### Iteration 2: Dev tooling (~15 min)

**What it adds:**
- `bun run dev` — watch mode with `--watch` flag
- `bun run build` — production build
- `bun run typecheck` — type checking without emit
- `.gitignore` — node_modules, .env, dist, `.claude/worktrees/` (used by other tooling like ultrareview/Agent isolation; junior itself stores worktrees in a sibling directory)
- `.env.example` — all required and optional env vars documented

**Test:** Edit a file → dev server reloads. `bun run typecheck` → clean. `.env` not tracked by git.
**Defers:** CI/CD, Docker, deployment.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Bun only (no Node fallback) | If Bun issues arise, switch to tsx + Node |
| No production build optimization | Post-MVP |
| No CI/CD | Post-MVP |
| JSON repo config in env var | Post-MVP (config file) |

## Cut List (true v2)

- Docker containerization
- CI/CD pipeline (GitHub Actions)
- Multi-environment config (dev/staging/prod)
- Health check HTTP endpoint (for monitoring)
- Structured logging (pino or similar)
- OpenTelemetry tracing
