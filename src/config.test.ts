import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadConfig } from "./config.ts";

const ENV_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "CLAUDE_MAX_TURNS",
  "CLAUDE_TIMEOUT_MS",
  "CLAUDE_PERMISSION_MODE",
  "CLAUDE_MODEL",
  "RUNNER_PROVIDER",
  "OPENCODE_MODEL",
  "OPENCODE_TIMEOUT_MS",
  "JUNIOR_OPENCODE_PERMISSION",
  "OPENCODE_MCP_ENABLED",
  "OPENCODE_SLACK_MCP_ENABLED",
  "OPENCODE_PLAYWRIGHT_MCP_ENABLED",
  "OPENCODE_MIXPANEL_MCP_ENABLED",
  "OPENCODE_MONGODB_MCP_ENABLED",
  "REPOS",
  "SESSION_STALE_TIMEOUT_MS",
  "SESSION_CLEANUP_INTERVAL_MS",
  "SESSION_STORE",
  "SESSION_DB_PATH",
  "HOME_WINDOW_MS",
  "SESSION_DEFAULT_VERBOSITY",
  "CHANNEL_DEFAULTS",
  "ADMIN_SLACK_USER_ID",
  "HTTP_DASHBOARD_PORT",
  "WORKLOG_CRON_ENABLED",
  "WORKLOG_SLACK_CHANNEL",
  "WORKLOG_SLACK_THREAD_TS",
  "WORKLOG_DAILY_AT",
  "WORKLOG_LOOKBACK_HOURS",
  "WORKLOG_DOCS_DIR",
  "WORKLOG_GIT_AUTHOR",
  "WORKLOG_GITHUB_USER",
  "WORKLOG_USE_AGENT",
  "WORKLOG_RUN_ON_STARTUP",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_APP_TOKEN = "xapp-test";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("loadConfig runner providers", () => {
  it("defaults to OpenCode runner and OpenCode defaults", () => {
    const config = loadConfig();

    expect(config.runner.provider).toBe("opencode");
    expect(config.opencode).toEqual({
      model: null,
      timeoutMs: 300000,
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
    });
  });

  it("parses runner provider and OpenCode env vars", () => {
    process.env.RUNNER_PROVIDER = "opencode";
    process.env.OPENCODE_MODEL = "openai/gpt-5.1";
    process.env.OPENCODE_TIMEOUT_MS = "1234";
    process.env.JUNIOR_OPENCODE_PERMISSION = "ask";
    process.env.OPENCODE_MCP_ENABLED = "false";
    process.env.OPENCODE_SLACK_MCP_ENABLED = "0";
    process.env.OPENCODE_PLAYWRIGHT_MCP_ENABLED = "false";
    process.env.OPENCODE_MIXPANEL_MCP_ENABLED = "0";
    process.env.OPENCODE_MONGODB_MCP_ENABLED = "false";

    const config = loadConfig();

    expect(config.runner.provider).toBe("opencode");
    expect(config.opencode).toEqual({
      model: "openai/gpt-5.1",
      timeoutMs: 1234,
      permission: "ask",
      mcpEnabled: false,
      slackMcpEnabled: false,
      playwrightMcpEnabled: false,
      mixpanelMcpEnabled: false,
      mongodbMcpEnabled: false,
    });
  });

  it("rejects unknown runner providers", () => {
    process.env.RUNNER_PROVIDER = "other";

    expect(() => loadConfig()).toThrow(
      "Invalid RUNNER_PROVIDER: other (expected opencode|claude)",
    );
  });

  it("rejects codex at config load with a not-implemented message", () => {
    process.env.RUNNER_PROVIDER = "codex";

    expect(() => loadConfig()).toThrow(
      "RUNNER_PROVIDER=codex is a planned provider but is not yet implemented. Use opencode or claude.",
    );
  });
});

describe("loadConfig worklog cron", () => {
  it("defaults the worklog cron off", () => {
    const config = loadConfig();

    expect(config.worklog).toEqual({
      enabled: false,
      channel: null,
      threadTs: null,
      dailyAt: "18:00",
      lookbackHours: 24,
      docsDir: "docs/worklog",
      gitAuthor: null,
      githubUser: null,
      useAgent: true,
      runOnStartup: false,
    });
  });

  it("requires a Slack channel when enabled", () => {
    process.env.WORKLOG_CRON_ENABLED = "true";

    expect(() => loadConfig()).toThrow(
      "WORKLOG_SLACK_CHANNEL is required when WORKLOG_CRON_ENABLED=true",
    );
  });

  it("parses worklog cron settings", () => {
    process.env.WORKLOG_CRON_ENABLED = "true";
    process.env.WORKLOG_SLACK_CHANNEL = "C123";
    process.env.WORKLOG_SLACK_THREAD_TS = "123.456";
    process.env.WORKLOG_DAILY_AT = "09:30";
    process.env.WORKLOG_LOOKBACK_HOURS = "12";
    process.env.WORKLOG_DOCS_DIR = "docs/status";
    process.env.WORKLOG_GIT_AUTHOR = "me@example.com";
    process.env.WORKLOG_GITHUB_USER = "octocat";
    process.env.WORKLOG_USE_AGENT = "false";
    process.env.WORKLOG_RUN_ON_STARTUP = "1";

    const config = loadConfig();

    expect(config.worklog).toEqual({
      enabled: true,
      channel: "C123",
      threadTs: "123.456",
      dailyAt: "09:30",
      lookbackHours: 12,
      docsDir: "docs/status",
      gitAuthor: "me@example.com",
      githubUser: "octocat",
      useAgent: false,
      runOnStartup: true,
    });
  });
});
