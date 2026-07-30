import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { allowedMcpServers } from "./mcp-config.ts";

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
});
