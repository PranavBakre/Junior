import type { SessionVerbosity } from "./session/types.ts";

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
  http: {
    /** Localhost dashboard. Off unless HTTP_DASHBOARD_PORT is set. */
    enabled: boolean;
    port: number;
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
    },
    repos: JSON.parse(optional("REPOS", "[]")) as RepoConfig[],
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
    http: {
      enabled: process.env.HTTP_DASHBOARD_PORT != null,
      port: Number(optional("HTTP_DASHBOARD_PORT", "0")),
    },
  };
}

function parseStoreKind(value: string): SessionStoreKind {
  if (value === "memory" || value === "sqlite") return value;
  throw new Error(`Invalid SESSION_STORE: ${value} (expected memory|sqlite)`);
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
