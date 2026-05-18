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

    const config = loadConfig();

    expect(config.runner.provider).toBe("opencode");
    expect(config.opencode).toEqual({
      model: "openai/gpt-5.1",
      timeoutMs: 1234,
      permission: "ask",
      mcpEnabled: false,
      slackMcpEnabled: false,
      playwrightMcpEnabled: false,
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
