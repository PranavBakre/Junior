import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { mapCodexRunPolicy } from "./policy.ts";

const config = {
  mode: "app-server" as const,
  model: null,
  timeoutMs: 300000,
  sandbox: "workspace-write" as const,
  askForApproval: "never" as const,
  searchEnabled: false,
  appServerContinuityEnabled: false,
  mcpEnabled: true,
  slackMcpEnabled: true,
  playwrightMcpEnabled: true,
  mixpanelMcpEnabled: true,
  mongodbMcpEnabled: true,
  memoryMcpEnabled: true,
  isolatedHomePath: "data/codex-home",
};

describe("mapCodexRunPolicy", () => {
  it("uses workspace-write defaults for normal agents", () => {
    const session = createSession("t", "c");

    expect(mapCodexRunPolicy({ config, session, cwd: "/repo" })).toEqual({
      approvalPolicy: "never",
      sandbox: "workspace-write",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      mcpAllowed: true,
    });
  });

  it("uses danger-full-access when configured for normal agents", () => {
    const session = createSession("t", "c");

    expect(mapCodexRunPolicy({
      config: { ...config, sandbox: "danger-full-access" },
      session,
      cwd: "/repo",
    })).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "fullAccess" },
      mcpAllowed: true,
    });
  });

  it("maps read-only agents to read-only sandbox with approval", () => {
    const session = createSession("t", "c");
    session.agentPermissions = { intent: "read-only", mcp: [], tools: [] };

    expect(mapCodexRunPolicy({ config, session, cwd: "/repo" })).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnlyAccess" },
      mcpAllowed: true,
    });
  });

  it("fails closed for no-tools agents", () => {
    const session = createSession("t", "c");
    session.agentPermissions = { intent: "no-tools", mcp: [], tools: [] };

    expect(mapCodexRunPolicy({ config, session, cwd: "/repo" })).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      mcpAllowed: false,
    });
  });

  it("preserves utility cwd carve-out unless MCP is explicit", () => {
    const session = createSession("t", "c");
    session.cwd = "/tmp/junior-utility";
    session.agentPermissions = { intent: "utility", mcp: [], tools: [] };

    expect(mapCodexRunPolicy({ config, session, cwd: session.cwd }).mcpAllowed).toBe(false);
  });

  it("infers read-only from Claude-style tools when no intent is declared", () => {
    const session = createSession("t", "c");
    session.agentPermissions = { intent: null, mcp: [], tools: ["Read", "Grep", "Glob"] };

    expect(mapCodexRunPolicy({ config, session, cwd: "/repo" })).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnlyAccess" },
    });
  });

  it("fails closed for unmapped Claude-style tools", () => {
    const session = createSession("t", "c");
    session.agentPermissions = { intent: null, mcp: [], tools: ["DangerZone"] };

    expect(mapCodexRunPolicy({ config, session, cwd: "/repo" })).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      mcpAllowed: false,
    });
  });
});
