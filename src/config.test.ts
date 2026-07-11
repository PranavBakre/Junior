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
  "OPENCODE_CONTINUITY_ENABLED",
  "JUNIOR_OPENCODE_PERMISSION",
  "OPENCODE_MCP_ENABLED",
  "OPENCODE_SLACK_MCP_ENABLED",
  "OPENCODE_PLAYWRIGHT_MCP_ENABLED",
  "OPENCODE_MIXPANEL_MCP_ENABLED",
  "OPENCODE_MONGODB_MCP_ENABLED",
  "CODEX_MODE",
  "CODEX_MODEL",
  "CODEX_TIMEOUT_MS",
  "CODEX_SANDBOX",
  "CODEX_ASK_FOR_APPROVAL",
  "CODEX_SEARCH_ENABLED",
  "CODEX_APP_SERVER_CONTINUITY_ENABLED",
  "CODEX_MCP_ENABLED",
  "CODEX_SLACK_MCP_ENABLED",
  "CODEX_PLAYWRIGHT_MCP_ENABLED",
  "CODEX_MIXPANEL_MCP_ENABLED",
  "CODEX_MONGODB_MCP_ENABLED",
  "CODEX_MEMORY_MCP_ENABLED",
  "CODEX_ISOLATED_HOME_PATH",
  "REPOS",
  "SESSION_STALE_TIMEOUT_MS",
  "SESSION_CLEANUP_INTERVAL_MS",
  "SESSION_STORE",
  "SESSION_DB_PATH",
  "HOME_WINDOW_MS",
  "SESSION_DEFAULT_VERBOSITY",
  "SESSION_IDLE_TIMEOUT_MS",
  "SESSION_MAX_IDLE_INTERRUPTS",
  "MEMORY_DB_PATH",
  "CHANNEL_DEFAULTS",
  "ADMIN_SLACK_USER_ID",
  "HTTP_DASHBOARD_PORT",
  "WHATSAPP_EXTRACTION_INTERVAL_MS",
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
      continuityEnabled: false,
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
    });
    expect(config.codex).toEqual({
      mode: "app-server",
      model: null,
      timeoutMs: 300000,
      sandbox: "workspace-write",
      askForApproval: "never",
      searchEnabled: false,
      appServerContinuityEnabled: false,
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
      memoryMcpEnabled: true,
      isolatedHomePath: "data/codex-home",
    });
    expect(config.memory.sqlitePath).toBe("data/memory.db");
    expect(config.session.idleTimeoutMs).toBe(300000);
    expect(config.session.maxIdleInterrupts).toBe(3);
  });

  it("parses memory db path", () => {
    process.env.MEMORY_DB_PATH = "data/test-memory.db";

    const config = loadConfig();

    expect(config.memory.sqlitePath).toBe("data/test-memory.db");
  });

  it("parses runner provider and OpenCode env vars", () => {
    process.env.RUNNER_PROVIDER = "opencode";
    process.env.OPENCODE_MODEL = "openai/gpt-5.1";
    process.env.OPENCODE_TIMEOUT_MS = "1234";
    process.env.OPENCODE_CONTINUITY_ENABLED = "true";
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
      continuityEnabled: true,
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
      "Invalid RUNNER_PROVIDER: other (expected opencode|opencode-sdk|codex-app-server|claude)",
    );
  });

  it("rejects codex at config load with a not-implemented message", () => {
    process.env.RUNNER_PROVIDER = "codex";

    expect(() => loadConfig()).toThrow(
      "RUNNER_PROVIDER=codex is a planned provider but is not yet implemented. Use opencode|opencode-sdk|codex-app-server|claude.",
    );
  });

  it("defaults WHATSAPP_EXTRACTION_INTERVAL_MS to 600000", () => {
    expect(loadConfig().whatsapp?.extractionIntervalMs).toBe(600000);
  });

  it("parses a valid WHATSAPP_EXTRACTION_INTERVAL_MS", () => {
    process.env.WHATSAPP_EXTRACTION_INTERVAL_MS = "120000";
    expect(loadConfig().whatsapp?.extractionIntervalMs).toBe(120000);
  });

  it.each(["0", "-1", "abc", "1.5", "Infinity", ""])(
    "rejects a non-positive-integer WHATSAPP_EXTRACTION_INTERVAL_MS (%p)",
    (raw) => {
      process.env.WHATSAPP_EXTRACTION_INTERVAL_MS = raw;
      expect(() => loadConfig()).toThrow(
        "Invalid WHATSAPP_EXTRACTION_INTERVAL_MS",
      );
    },
  );

  it("parses codex-app-server provider and Codex env vars", () => {
    process.env.RUNNER_PROVIDER = "codex-app-server";
    process.env.CODEX_MODE = "app-server";
    process.env.CODEX_MODEL = "gpt-5.5";
    process.env.CODEX_TIMEOUT_MS = "2345";
    process.env.CODEX_SANDBOX = "read-only";
    process.env.CODEX_ASK_FOR_APPROVAL = "on-request";
    process.env.CODEX_SEARCH_ENABLED = "true";
    process.env.CODEX_APP_SERVER_CONTINUITY_ENABLED = "1";
    process.env.CODEX_MCP_ENABLED = "false";
    process.env.CODEX_SLACK_MCP_ENABLED = "0";
    process.env.CODEX_PLAYWRIGHT_MCP_ENABLED = "false";
    process.env.CODEX_MIXPANEL_MCP_ENABLED = "0";
    process.env.CODEX_MONGODB_MCP_ENABLED = "false";
    process.env.CODEX_MEMORY_MCP_ENABLED = "0";
    process.env.CODEX_ISOLATED_HOME_PATH = "/tmp/junior-codex-home-test";

    const config = loadConfig();

    expect(config.runner.provider).toBe("codex-app-server");
    expect(config.codex).toEqual({
      mode: "app-server",
      model: "gpt-5.5",
      timeoutMs: 2345,
      sandbox: "read-only",
      askForApproval: "on-request",
      searchEnabled: true,
      appServerContinuityEnabled: true,
      mcpEnabled: false,
      slackMcpEnabled: false,
      playwrightMcpEnabled: false,
      mixpanelMcpEnabled: false,
      mongodbMcpEnabled: false,
      memoryMcpEnabled: false,
      isolatedHomePath: "/tmp/junior-codex-home-test",
    });
  });
});
