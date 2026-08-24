import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { allowedMcpServers, needsUserSettings } from "./mcp-config.ts";

describe("assignment-scoped MCP compilation", () => {
  it("adds only MCP servers implied by the validated capability envelope", () => {
    const session = createSession("thread-skill", "C01");
    session.activeAgentName = "skill:data-lookup";
    session.agentPermissions = {
      intent: "read-only",
      mcp: [],
      tools: [],
    };
    session.assignmentCapabilities = [
      "mongodb-read",
      "pipeline-artifact-write",
    ];

    expect([...allowedMcpServers(session)].sort()).toEqual([
      "mongodb",
      "slack-bot",
    ]);
  });

  it("requires user settings only for explicitly requested OAuth MCPs", () => {
    const session = createSession("thread-oauth", "C01");
    session.agentPermissions = { intent: "normal", mcp: [], tools: [] };
    expect(needsUserSettings(session)).toBe(false);

    session.agentPermissions.mcp = ["figma"];
    expect(needsUserSettings(session)).toBe(true);

    session.agentPermissions.mcp = ["notion"];
    expect(needsUserSettings(session)).toBe(true);
  });
});
