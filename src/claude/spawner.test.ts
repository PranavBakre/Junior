import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import {
  buildClaudeMcpConfig,
  classifyClaudeCompletion,
  widenSettingSources,
  selectClaudeResponse,
  shouldUseClaudeMcpConfig,
} from "./spawner.ts";

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

describe("Claude MCP capability gating", () => {
  it("does not expose hosted OAuth servers to the default agent", () => {
    const session = createSession("thread-1", "C01");
    session.agentPermissions = { intent: "normal", mcp: [], tools: [] };

    expect(buildClaudeMcpConfig(session)).toEqual({ mcpServers: {} });
  });

  it("exposes only the hosted OAuth server requested by the active agent", () => {
    const session = createSession("thread-1", "C01");
    session.agentPermissions = { intent: "normal", mcp: ["figma"], tools: [] };

    expect(buildClaudeMcpConfig(session)).toEqual({
      mcpServers: {
        figma: { type: "http", url: "https://mcp.figma.com/mcp" },
      },
    });
  });

  it("widens settings only for the OAuth-enabled run", () => {
    const config = { settingSources: "project" } as Parameters<typeof widenSettingSources>[0];
    expect(widenSettingSources(config).settingSources).toBe("user,project");
    expect((config.settingSources ?? "")).toBe("project");
  });
});

describe("selectClaudeResponse", () => {
  it("preserves the last assistant turn when an incomplete result has no text", () => {
    expect(selectClaudeResponse("", "I finished the diagnosis before the cap.")).toBe(
      "I finished the diagnosis before the cap.",
    );
  });

  it("prefers provider result text when present", () => {
    expect(selectClaudeResponse("final result", "earlier assistant text")).toBe(
      "final result",
    );
  });
});

describe("classifyClaudeCompletion", () => {
  it("does not treat error_max_turns with exit zero as success", () => {
    expect(
      classifyClaudeCompletion(
        { type: "result", subtype: "error_max_turns", num_turns: 25 },
        0,
        null,
      ),
    ).toEqual({
      status: "incomplete",
      reason: "max_turns",
      retryable: true,
      providerSubtype: "error_max_turns",
      turns: 25,
    });
  });

  it("fails closed when Claude exits without a terminal result", () => {
    expect(classifyClaudeCompletion(null, 0, null)).toEqual({
      status: "incomplete",
      reason: "missing_result",
      retryable: true,
    });
  });

  it("recognizes only an explicit success subtype as success", () => {
    expect(
      classifyClaudeCompletion(
        { type: "result", subtype: "success", num_turns: 3 },
        0,
        null,
      ).status,
    ).toBe("success");
    expect(
      classifyClaudeCompletion(
        { type: "result", subtype: "error_during_execution" },
        0,
        null,
      ).status,
    ).toBe("failure");
  });
});
