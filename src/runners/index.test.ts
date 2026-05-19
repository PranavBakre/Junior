import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import { createSession } from "../session/types.ts";
import { buildOpenCodeMcpConfig } from "./index.ts";

describe("buildOpenCodeMcpConfig", () => {
  it("only includes Mixpanel MCP for the feature-metrics agent", () => {
    const mainSession = createSession("thread-1", "C01");
    const featureMetricsSession = createSession("thread-1", "C01");
    featureMetricsSession.agentType = "feature-metrics";

    const mainMcp = buildOpenCodeMcpConfig(testConfig(), mainSession);
    const featureMetricsMcp = buildOpenCodeMcpConfig(
      testConfig(),
      featureMetricsSession,
    );

    expect(mainMcp?.mixpanel).toBeUndefined();
    expect(featureMetricsMcp?.mixpanel).toEqual({
      type: "local",
      command: ["npx", "-y", "mcp-remote", "https://mcp.mixpanel.com/mcp"],
      enabled: true,
    });
  });

  it("respects the Mixpanel MCP feature flag", () => {
    const session = createSession("thread-1", "C01");
    session.agentType = "feature-metrics";

    const mcp = buildOpenCodeMcpConfig(
      testConfig({ mixpanelMcpEnabled: false }),
      session,
    );

    expect(mcp?.mixpanel).toBeUndefined();
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
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      ...opencodeOverrides,
    },
    repos: [],
    session: {
      staleTimeoutMs: 86400000,
      cleanupIntervalMs: 900000,
      store: "memory",
      sqlitePath: "data/sessions.db",
      homeWindowMs: 172800000,
      defaultVerbosity: "normal",
    },
    channelDefaults: {},
    adminSlackUserId: null,
    http: { enabled: false, port: 0 },
  };
}
