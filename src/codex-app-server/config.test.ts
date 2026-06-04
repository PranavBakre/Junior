import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { buildCodexConfigToml, buildCodexMcpConfig } from "./config.ts";
import type { Config } from "../config.ts";

describe("buildCodexMcpConfig", () => {
  it("builds only agent-declared MCP servers and honors utility carve-out", () => {
    const session = createSession("t", "c");
    session.agentPermissions = { intent: "normal", mcp: ["slack-bot", "playwright"], tools: [] };
    const mcp = buildCodexMcpConfig(makeConfig(), session, true);

    expect(mcp).toMatchObject({
      "slack-bot": {
        transport: "http",
        url: expect.stringContaining("http://localhost:3456/mcp?agent=default&channel=c&thread=t"),
      },
      playwright: {
        command: expect.stringContaining("junior-mcp-stdio-wrapper.js"),
        args: ["--", "npx", "@playwright/mcp", "--headless"],
      },
    });
    expect(buildCodexMcpConfig(makeConfig(), session, false)).toBeNull();
  });

  it("does not start local MCP servers when the agent declares none", () => {
    const session = createSession("t", "c");

    expect(buildCodexMcpConfig(makeConfig(), session, true)).toBeNull();
  });

  it("limits MCP servers to explicitly declared agent permissions", () => {
    const session = createSession("t", "c");
    session.agentPermissions = { intent: "normal", mcp: ["playwright"], tools: [] };

    expect(buildCodexMcpConfig(makeConfig(), session, true)).toEqual({
      playwright: {
        command: expect.stringContaining("junior-mcp-stdio-wrapper.js"),
        args: ["--", "npx", "@playwright/mcp", "--headless"],
      },
    });
  });

  it("uses Junior's MongoDB HTTP proxy instead of spawning local MongoDB MCP", () => {
    const session = createSession("t", "c");
    session.agentPermissions = { intent: "normal", mcp: ["mongodb"], tools: [] };

    expect(buildCodexMcpConfig(makeConfig(), session, true)).toEqual({
      mongodb: {
        transport: "http",
        url: expect.stringContaining("http://localhost:3456/mcp/mongodb?agent=default&channel=c&thread=t"),
      },
    });
  });
});

describe("buildCodexConfigToml", () => {
  it("serializes minimal isolated Codex config", () => {
    expect(
      buildCodexConfigToml({
        model: "gpt-5.5",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        mcp: {
          "slack-bot": {
            transport: "http",
            url: "http://localhost:3456/mcp",
          },
        },
        trustedProjectPath: "/repo",
      }),
    ).toContain('[projects."/repo"]\ntrust_level = "trusted"');
    expect(
      buildCodexConfigToml({
        model: "gpt-5.5",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        mcp: null,
      }),
    ).toContain('sandbox_mode = "danger-full-access"');
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
    threadArchives: { dir: "data/thread-archives" },
    channelDefaults: {},
    adminSlackUserId: null,
    http: { enabled: false, port: 0 },
  };
}
