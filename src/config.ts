import {
  isImplementedRunnerProvider,
  isRunnerProvider,
  type ImplementedRunnerProvider,
  type DriverMode,
  type SessionVerbosity,
} from "./session/types.ts";

export interface RepoConfig {
  name: string;
  path: string;
  defaultBase: string;
  /**
   * Optional. When set, Junior delegates worktree creation to this script via
   * `<repo.path>/<command> <branch> --path <abs> [--base <ref>]`. The script
   * must `git fetch`, `git worktree add` at the given path, and perform setup
   * (env copy, install, MCPs). Junior always forwards `--base <ref>`,
   * defaulting to `repo.defaultBase` when the caller doesn't override —
   * Junior worktrees are reproducible from a known ref, never from whatever
   * the local checkout happens to be on. Manual users can omit `--base` to
   * fall back to the script's per-repo default. When `worktreeSetupCommand`
   * is unset, Junior runs `git fetch origin --prune` and `git worktree add`
   * inline (no setup hook).
   */
  worktreeSetupCommand?: string;
  /**
   * Command to start the dev server (e.g. "pnpm dev", "npm run dev").
   * Split on whitespace and passed directly to Bun.spawn — no shell.
   * Leave unset for repos that don't run a dev server.
   */
  devCommand?: string;
  /**
   * Port the dev server listens on (e.g. 3000, 8000).
   * Used for readiness probing and external-listener conflict detection.
   */
  devPort?: number;
  /**
   * URL junior curls to confirm the dev server is ready (expects HTTP 200).
   * Defaults to http://localhost:<devPort> when unset.
   */
  readyUrl?: string;
}

export type SessionStoreKind = "memory" | "sqlite";

export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
  };
  claude: {
    maxTurns: number;
    timeoutMs: number;
    permissionMode: string;
    defaultModel: string | null;
    /**
     * Default driver for new threads. Override per-thread via `!driver`.
     * Set via `DEFAULT_CLAUDE_DRIVER` env (headless|tmux). Defaults to
     * "headless" while the tmux path is being soaked.
     */
    defaultDriver: DriverMode;
    /** Idle TTL before a tmux session is evicted (`tmux kill-session`). */
    tmuxIdleTtlMs: number;
    /** How often the eviction sweep runs. */
    tmuxSweepIntervalMs: number;
  };
  runner: {
    provider: ImplementedRunnerProvider;
  };
  opencode: {
    model: string | null;
    timeoutMs: number;
    permission: string;
    mcpEnabled: boolean;
    slackMcpEnabled: boolean;
    playwrightMcpEnabled: boolean;
    mixpanelMcpEnabled: boolean;
    mongodbMcpEnabled: boolean;
  };
  repos: RepoConfig[];
  session: {
    staleTimeoutMs: number;
    cleanupIntervalMs: number;
    store: SessionStoreKind;
    sqlitePath: string;
    homeWindowMs: number;
    defaultVerbosity: SessionVerbosity;
  };
  channelDefaults: Record<string, { agentType: string }>;
  /**
   * Single Slack user ID allowed to run elevated commands (`!mute`, `!unmute`,
   * `!reset`). When unset, those commands are open to anyone — useful for local
   * dev. In production this should always be set.
   */
  adminSlackUserId: string | null;
  http: {
    /** Localhost dashboard. Off unless HTTP_DASHBOARD_PORT is set. */
    enabled: boolean;
    port: number;
  };
  worklog: {
    /** Daily PR/commit digest. Off unless WORKLOG_CRON_ENABLED=true. */
    enabled: boolean;
    /** Slack channel to post the digest into. Required when enabled. */
    channel: string | null;
    /** Optional thread timestamp; when unset the digest is posted as a channel message. */
    threadTs: string | null;
    /** Local server time in HH:mm, e.g. 18:30. */
    dailyAt: string;
    /** Activity lookback window for commits and PR updates. */
    lookbackHours: number;
    /** Where markdown snapshots are written. */
    docsDir: string;
    /** Optional git log author filter. Defaults to each repo's git user when unset. */
    gitAuthor: string | null;
    /** Optional GitHub username for PR filtering. Defaults to gh's authenticated user when unset. */
    githubUser: string | null;
    /** Let the configured runner compress/group the collected activity before Slack posting. */
    useAgent: boolean;
    /** Run once immediately after boot, useful for local verification. */
    runOnStartup: boolean;
  };
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  return {
    slack: {
      botToken: required("SLACK_BOT_TOKEN"),
      appToken: required("SLACK_APP_TOKEN"),
      signingSecret: optional("SLACK_SIGNING_SECRET", ""),
    },
    claude: {
      maxTurns: Number(optional("CLAUDE_MAX_TURNS", "25")),
      timeoutMs: Number(optional("CLAUDE_TIMEOUT_MS", "300000")),
      permissionMode: optional("CLAUDE_PERMISSION_MODE", "bypassPermissions"),
      defaultModel: process.env.CLAUDE_MODEL ?? null,
      defaultDriver: parseDriverMode(optional("DEFAULT_CLAUDE_DRIVER", "headless")),
      tmuxIdleTtlMs: Number(optional("TMUX_IDLE_TTL_MS", "14400000")), // 4h
      tmuxSweepIntervalMs: Number(optional("TMUX_SWEEP_INTERVAL_MS", "900000")), // 15min
    },
    runner: {
      provider: parseRunnerProvider(optional("RUNNER_PROVIDER", "opencode")),
    },
    opencode: {
      model: process.env.OPENCODE_MODEL ?? null,
      timeoutMs: Number(optional("OPENCODE_TIMEOUT_MS", "300000")),
      permission: optional("JUNIOR_OPENCODE_PERMISSION", "allow"),
      mcpEnabled: parseBooleanEnv("OPENCODE_MCP_ENABLED", true),
      slackMcpEnabled: parseBooleanEnv("OPENCODE_SLACK_MCP_ENABLED", true),
      playwrightMcpEnabled: parseBooleanEnv(
        "OPENCODE_PLAYWRIGHT_MCP_ENABLED",
        true,
      ),
      mixpanelMcpEnabled: parseBooleanEnv(
        "OPENCODE_MIXPANEL_MCP_ENABLED",
        true,
      ),
      mongodbMcpEnabled: parseBooleanEnv("OPENCODE_MONGODB_MCP_ENABLED", true),
    },
    repos: (JSON.parse(optional("REPOS", "[]")) as RepoConfig[]).map((r) => ({
      ...r,
      // Strip any trailing slashes so path-construction sites can do
      // `${r.path}.junior-worktrees/...` without producing
      // `<repo>//.junior-worktrees/...` (which collapses to a path INSIDE
      // the repo and recreates the recursive-copy bug).
      path: r.path.replace(/\/+$/, ""),
    })),
    session: {
      staleTimeoutMs: Number(optional("SESSION_STALE_TIMEOUT_MS", "86400000")),
      cleanupIntervalMs: Number(
        optional("SESSION_CLEANUP_INTERVAL_MS", "900000"),
      ),
      store: parseStoreKind(optional("SESSION_STORE", "sqlite")),
      sqlitePath: optional("SESSION_DB_PATH", "data/sessions.db"),
      homeWindowMs: Number(optional("HOME_WINDOW_MS", "172800000")),
      defaultVerbosity: parseVerbosity(
        optional("SESSION_DEFAULT_VERBOSITY", "normal"),
      ),
    },
    channelDefaults: parseChannelDefaults(
      optional(
        "CHANNEL_DEFAULTS",
        '{"C05557KKV37":{"agentType":"lead"}}',
      ),
    ),
    adminSlackUserId: process.env.ADMIN_SLACK_USER_ID?.trim() || null,
    http: parseHttpDashboard(process.env.HTTP_DASHBOARD_PORT),
    worklog: parseWorklogConfig(),
  };
}

/**
 * Parse HTTP_DASHBOARD_PORT strictly.
 *
 * - Unset or empty → dashboard disabled (port 0).
 * - Positive integer string → enabled on that port.
 * - Anything else (NaN, 0, negative, decimal) → throw at config load. The
 *   prior `Number(...)` fallback would silently let `Bun.serve` bind to a
 *   random port for non-numeric values, which is surprising and makes the
 *   dashboard unreachable at the configured URL.
 */
function parseHttpDashboard(raw: string | undefined): { enabled: boolean; port: number } {
  if (raw == null || raw === "") {
    return { enabled: false, port: 0 };
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid HTTP_DASHBOARD_PORT: ${JSON.stringify(raw)} (expected positive integer 1-65535, or unset to disable)`,
    );
  }
  return { enabled: true, port };
}

function parseStoreKind(value: string): SessionStoreKind {
  if (value === "memory" || value === "sqlite") return value;
  throw new Error(`Invalid SESSION_STORE: ${value} (expected memory|sqlite)`);
}

function parseRunnerProvider(value: string): ImplementedRunnerProvider {
  if (isImplementedRunnerProvider(value)) return value;
  if (isRunnerProvider(value)) {
    // Known provider, not yet implemented. Fail at config load with the real
    // cause rather than throwing on the first message turn.
    throw new Error(
      `RUNNER_PROVIDER=${value} is a planned provider but is not yet implemented. Use opencode or claude.`,
    );
  }
  throw new Error(
    `Invalid RUNNER_PROVIDER: ${value} (expected opencode|claude)`,
  );
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(
    `Invalid ${name}: ${JSON.stringify(value)} (expected true|false)`,
  );
}

function parseDriverMode(value: string): DriverMode {
  if (value === "headless" || value === "tmux") return value;
  throw new Error(`Invalid DEFAULT_CLAUDE_DRIVER: ${value} (expected headless|tmux)`);
}

function parseWorklogConfig(): Config["worklog"] {
  const enabled = parseBooleanEnv("WORKLOG_CRON_ENABLED", false);
  const channel = process.env.WORKLOG_SLACK_CHANNEL?.trim() || null;
  if (enabled && !channel) {
    throw new Error("WORKLOG_SLACK_CHANNEL is required when WORKLOG_CRON_ENABLED=true");
  }

  const dailyAt = optional("WORKLOG_DAILY_AT", "18:00");
  if (!/^\d{2}:\d{2}$/.test(dailyAt)) {
    throw new Error("Invalid WORKLOG_DAILY_AT: expected HH:mm");
  }
  const [hour, minute] = dailyAt.split(":").map(Number);
  if (hour > 23 || minute > 59) {
    throw new Error("Invalid WORKLOG_DAILY_AT: expected HH:mm in 24-hour time");
  }

  const lookbackHours = Number(optional("WORKLOG_LOOKBACK_HOURS", "24"));
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error("Invalid WORKLOG_LOOKBACK_HOURS: expected positive number");
  }

  return {
    enabled,
    channel,
    threadTs: process.env.WORKLOG_SLACK_THREAD_TS?.trim() || null,
    dailyAt,
    lookbackHours,
    docsDir: optional("WORKLOG_DOCS_DIR", "docs/worklog"),
    gitAuthor: process.env.WORKLOG_GIT_AUTHOR?.trim() || null,
    githubUser: process.env.WORKLOG_GITHUB_USER?.trim() || null,
    useAgent: parseBooleanEnv("WORKLOG_USE_AGENT", true),
    runOnStartup: parseBooleanEnv("WORKLOG_RUN_ON_STARTUP", false),
  };
}

function parseChannelDefaults(
  value: string,
): Record<string, { agentType: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`Invalid CHANNEL_DEFAULTS JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid CHANNEL_DEFAULTS: expected object of {channelId: {agentType}}`,
    );
  }
  const out: Record<string, { agentType: string }> = {};
  for (const [channelId, entry] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { agentType?: unknown }).agentType !== "string"
    ) {
      throw new Error(
        `Invalid CHANNEL_DEFAULTS entry for ${channelId}: expected {agentType: string}`,
      );
    }
    out[channelId] = { agentType: (entry as { agentType: string }).agentType };
  }
  return out;
}

function parseVerbosity(value: string): SessionVerbosity {
  if (value === "quiet" || value === "normal" || value === "verbose") {
    return value;
  }
  throw new Error(
    `Invalid SESSION_DEFAULT_VERBOSITY: ${value} (expected quiet|normal|verbose)`,
  );
}
