import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { shouldUseClaudeMcpConfig } from "./spawner.ts";

describe("shouldUseClaudeMcpConfig", () => {
  it("keeps the utility cwd carve-out even when the agent declares MCP servers", () => {
    const session = createSession("thread-1", "C01");
    session.cwd = "/tmp/junior-utility";
    session.agentPermissions = { intent: "normal", mcp: ["slack-bot", "mongodb"], tools: [] };

    expect(shouldUseClaudeMcpConfig(session, false)).toBe(false);
  });

  it("uses generated MCP config for root runs with declared MCP servers", () => {
    const session = createSession("thread-1", "C01");
    session.agentPermissions = { intent: "normal", mcp: ["mongodb"], tools: [] };

    expect(shouldUseClaudeMcpConfig(session, false)).toBe(true);
  });

  it("uses generated MCP config for worktree-backed runs", () => {
    const session = createSession("thread-1", "C01");

    expect(shouldUseClaudeMcpConfig(session, true)).toBe(true);
  });
});
