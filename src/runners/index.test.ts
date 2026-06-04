import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import { createSession } from "../session/types.ts";
import { buildOpenCodeMcpConfig } from "./index.ts";

describe("buildOpenCodeMcpConfig", () => {
  it("only includes Mixpanel MCP for the feature-metrics agent", () => {
    const mainSession = createSession("thread-1", "C01");
    const featureMetricsSession = createSession("thread-1", "C01");
    mainSession.agentPermissions = { intent: "normal", mcp: ["mixpanel"], tools: [] };
    featureMetricsSession.agentType = "feature-metrics";
    featureMetricsSession.agentPermissions = { intent: "normal", mcp: ["mixpanel"], tools: [] };

    const mainMcp = buildOpenCodeMcpConfig(testConfig(), mainSession);
    const featureMetricsMcp = buildOpenCodeMcpConfig(
      testConfig(),
      featureMetricsSession,
    );

    expect(mainMcp?.mixpanel).toBeUndefined();
    expect(featureMetricsMcp?.mixpanel).toEqual({
      type: "local",
      command: [
        expect.stringContaining("junior-mcp-stdio-wrapper.js"),
        "--",
        "npx",
        "-y",
        "mcp-remote",
        "https://mcp.mixpanel.com/mcp",
      ],
      enabled: true,
    });
  });

  it("respects the Mixpanel MCP feature flag", () => {
    const session = createSession("thread-1", "C01");
    session.agentType = "feature-metrics";
    session.agentPermissions = { intent: "normal", mcp: ["mixpanel"], tools: [] };

    const mcp = buildOpenCodeMcpConfig(
      testConfig({ mixpanelMcpEnabled: false }),
      session,
    );

    expect(mcp?.mixpanel).toBeUndefined();
  });

  it("includes MongoDB MCP for agents with explicit MongoDB permission", () => {
    const mainSession = createSession("thread-1", "C01");
    const dbExecutionerSession = createSession("thread-1", "C01");
    mainSession.agentPermissions = { intent: "normal", mcp: ["mongodb"], tools: [] };
    dbExecutionerSession.agentType = "db-executioner";
    dbExecutionerSession.agentPermissions = { intent: "normal", mcp: ["mongodb"], tools: [] };

    const mainMcp = buildOpenCodeMcpConfig(testConfig(), mainSession);
    const dbExecutionerMcp = buildOpenCodeMcpConfig(
      testConfig(),
      dbExecutionerSession,
    );

    expect(mainMcp?.mongodb).toEqual({
      type: "remote",
      url: expect.stringContaining("http://localhost:3456/mcp/mongodb?agent=default&channel=C01&thread=thread-1"),
      enabled: true,
    });
    expect(dbExecutionerMcp?.mongodb).toEqual({
      type: "remote",
      url: expect.stringContaining("http://localhost:3456/mcp/mongodb?agent=default&channel=C01&thread=thread-1"),
      enabled: true,
    });
  });

  it("respects the MongoDB MCP feature flag", () => {
    const session = createSession("thread-1", "C01");
    session.agentType = "db-executioner";
    session.agentPermissions = { intent: "normal", mcp: ["mongodb"], tools: [] };

    const mcp = buildOpenCodeMcpConfig(
      testConfig({ mongodbMcpEnabled: false }),
      session,
    );

    expect(mcp?.mongodb).toBeUndefined();
  });
});

function testConfig(
  opencodeOverrides: Partial<Config["opencode"]> = {},
): Config {
  return {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "",
    },
    claude: {
      maxTurns: 25,
      timeoutMs: 300000,
      permissionMode: "bypassPermissions",
      defaultModel: null,
      defaultDriver: "headless",
      tmuxIdleTtlMs: 14400000,
      tmuxSweepIntervalMs: 900000,
    },
    runner: { provider: "opencode" },
    opencode: {
      model: null,
      timeoutMs: 300000,
      continuityEnabled: false,
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
      ...opencodeOverrides,
    },
    codex: {
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
    },
    repos: [],
    session: {
      staleTimeoutMs: 86400000,
      cleanupIntervalMs: 900000,
      store: "memory",
      sqlitePath: "data/sessions.db",
      homeWindowMs: 172800000,
      defaultVerbosity: "normal",
      idleTimeoutMs: 300000,
      maxIdleInterrupts: 3,
    },
    memory: { sqlitePath: "data/memory.db" },
    threadArchives: { dir: "data/thread-archives" },
    channelDefaults: {},
    adminSlackUserId: null,
    http: { enabled: false, port: 0 },
  };
}
