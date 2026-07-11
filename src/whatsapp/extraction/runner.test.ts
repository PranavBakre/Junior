import { describe, expect, test } from "bun:test";

import { buildExtractionArgs } from "./runner.ts";

describe("buildExtractionArgs — untrusted-content lockdown", () => {
  const args = buildExtractionArgs("claude-opus-4-6");

  test("pins the model and requests JSON output", () => {
    expect(args).toContain("-p");
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("claude-opus-4-6");
    const fmtIdx = args.indexOf("--output-format");
    expect(args[fmtIdx + 1]).toBe("json");
  });

  test("disables ALL built-in tools with --tools ''", () => {
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    // The empty-string argument is the CLI's disable-all-tools switch.
    expect(args[toolsIdx + 1]).toBe("");
  });

  test("loads no MCP servers via --strict-mcp-config (with no --mcp-config)", () => {
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  test("never enables a permission-bypass or tool-allow flag", () => {
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--permission-mode");
  });
});
