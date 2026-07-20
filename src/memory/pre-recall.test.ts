import { describe, expect, test } from "bun:test";
import { buildPreRecallClaudeArgs } from "./pre-recall.ts";

describe("buildPreRecallClaudeArgs", () => {
  const args = buildPreRecallClaudeArgs("claude-haiku-4-5-20251001");

  test("locks the subprocess down for untrusted Slack input", () => {
    // No tools, no ambient MCP servers, no user/project hooks — the same
    // lockdown contract as the other untrusted-content claude -p runners.
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    const settingsIdx = args.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(JSON.parse(args[settingsIdx + 1]!)).toEqual({ disableAllHooks: true });
  });

  test("keeps the message off argv (stdin-only prompt)", () => {
    // Bare -p with no inline prompt: the caller writes the message to stdin.
    expect(args[0]).toBe("-p");
    expect(args[1]).toMatch(/^--/);
  });
});
