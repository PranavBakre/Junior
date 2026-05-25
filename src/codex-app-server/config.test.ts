import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { buildCodexConfigToml, buildCodexMcpConfig } from "./config.ts";
import type { Config } from "../config.ts";

describe("buildCodexMcpConfig", () => {
  it("builds Junior-approved MCP servers and honors utility carve-out", () => {
    const session = createSession("t", "c");
    const mcp = buildCodexMcpConfig(makeConfig(), session, true);

    expect(mcp).toMatchObject({
      "slack-bot": {
        transport: "http",
        url: "http://localhost:3456/mcp",
      },
      playwright: {
        command: "npx",
        args: ["@playwright/mcp", "--headless"],
      },
    });
    expect(buildCodexMcpConfig(makeConfig(), session, false)).toBeNull();
  });

  it("limits MCP servers to explicitly declared agent permissions", () => {
    const session = createSession("t", "c");
    session.agentPermissions = { intent: "normal", mcp: ["playwright"], tools: [] };

    expect(buildCodexMcpConfig(makeConfig(), session, true)).toEqual({
      playwright: {
        command: "npx",
        args: ["@playwright/mcp", "--headless"],
      },
    });
  });
});

describe("buildCodexConfigToml", () => {
  it("serializes minimal isolated Codex config", () => {
    expect(
      buildCodexConfigToml({
        model: "gpt-5.1-codex",
        mcp: {
          "slack-bot": {
            transport: "http",
            url: "http://localhost:3456/mcp",
          },
        },
        trustedProjectPath: "/repo",
      }),
    ).toContain('[projects."/repo"]\ntrust_level = "trusted"');
  });
});

function makeConfig(): Config {
  return {
    slack: { botToken: "xoxb", appToken: "xapp", signingSecret: "" },
    claude: {
      maxTurns: 25,
      timeoutMs: 300000,
      permissionMode: "bypassPermissions",
      defaultModel: null,
      defaultDriver: "headless",
      tmuxIdleTtlMs: 1,
      tmuxSweepIntervalMs: 1,
    },
    runner: { provider: "codex-app-server" },
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
      staleTimeoutMs: 1,
      cleanupIntervalMs: 1,
      store: "memory",
      sqlitePath: ":memory:",
      homeWindowMs: 1,
      defaultVerbosity: "normal",
      idleTimeoutMs: 1,
      maxIdleInterrupts: 1,
    },
    memory: { sqlitePath: "data/memory.db" },
    channelDefaults: {},
    adminSlackUserId: null,
    http: { enabled: false, port: 0 },
  };
}
