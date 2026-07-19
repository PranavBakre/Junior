import { describe, expect, test } from "bun:test";
import { createSession } from "../session/types.ts";
import type { ThreadSession } from "../session/types.ts";
import { mapClaudeRunPolicy } from "./policy.ts";

const config = {
  maxTurns: 10,
  timeoutMs: 300000,
  permissionMode: "acceptEdits",
  defaultModel: null,
  defaultDriver: "headless" as const,
  tmuxIdleTtlMs: 0,
  tmuxSweepIntervalMs: 0,
};

function sessionWith(
  permissions?: ThreadSession["agentPermissions"],
): ThreadSession {
  const session = createSession("t", "c");
  session.agentPermissions = permissions;
  return session;
}

describe("mapClaudeRunPolicy", () => {
  test("read-only locks down writes and uses plan mode", () => {
    const session = sessionWith({
      intent: "read-only",
      mcp: [],
      tools: ["Read", "Grep", "Glob"],
    });

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    expect(policy.disallowedTools).toContain("Edit");
    expect(policy.disallowedTools).toContain("Write");
    expect(policy.disallowedTools).toContain("NotebookEdit");
    // declared tools flow through verbatim
    expect(policy.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(policy.addDirs).toEqual([]);
  });

  test("read-only with no declared tools yields empty allowedTools", () => {
    const session = sessionWith({ intent: "read-only", mcp: [], tools: [] });

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.allowedTools).toEqual([]);
    expect(policy.addDirs).toEqual([]);
  });

  test("no-tools is the hardest lockdown", () => {
    const session = sessionWith({ intent: "no-tools", mcp: [], tools: ["Read"] });

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    expect(policy.disallowedTools).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ]);
    expect(policy.allowedTools).toEqual([]);
    expect(policy.addDirs).toEqual([]);
  });

  test("human-gated proposes in plan mode with cwd access", () => {
    const session = sessionWith({
      intent: "human-gated",
      mcp: [],
      tools: ["Read", "Edit"],
    });

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    expect(policy.allowedTools).toEqual(["Read", "Edit"]);
    expect(policy.disallowedTools).toEqual([]);
    expect(policy.addDirs).toEqual(["/repo"]);
  });

  test("utility preserves the configured permission mode", () => {
    const session = sessionWith({ intent: "utility", mcp: [], tools: ["Read"] });

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("acceptEdits");
    expect(policy.allowedTools).toEqual(["Read"]);
    expect(policy.disallowedTools).toEqual([]);
    expect(policy.addDirs).toEqual(["/repo"]);
  });

  test("normal agents get bypassPermissions confined to cwd", () => {
    const session = sessionWith({ intent: "normal", mcp: [], tools: [] });

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("bypassPermissions");
    expect(policy.allowedTools).toEqual([]);
    expect(policy.disallowedTools).toEqual([]);
    expect(policy.addDirs).toEqual(["/repo"]);
  });

  test("null/unset intent behaves like normal for non-restricted roles", () => {
    const session = createSession("t", "c");

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("bypassPermissions");
    expect(policy.allowedTools).toEqual([]);
    expect(policy.disallowedTools).toEqual([]);
    expect(policy.addDirs).toEqual(["/repo"]);
  });

  test("missing intent fails closed for review/reproducer roles", () => {
    const session = createSession("t", "c");
    session.activeAgentName = "review";
    session.agentPermissions = { intent: null, mcp: [], tools: ["Read"] };

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    expect(policy.disallowedTools).toContain("Edit");
    expect(policy.disallowedTools).toContain("Write");
  });

  test("missing intent fails closed for pm/architect roles", () => {
    const session = createSession("t", "c");
    session.activeAgentName = "pm";
    session.agentPermissions = { intent: null, mcp: [], tools: ["Read", "Write"] };

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    expect(policy.allowedTools).toEqual(["Read", "Write"]);
  });

  test("declared intent cannot widen catalog ceiling for restricted roles", () => {
    // Phase 3: target-repo / session overrides must not grant review product-code writes.
    const session = sessionWith({ intent: "normal", mcp: [], tools: [] });
    session.activeAgentName = "review";

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    expect(policy.disallowedTools).toContain("Edit");
  });

  test("declared intent may narrow catalog ceiling", () => {
    const session = sessionWith({ intent: "no-tools", mcp: [], tools: [] });
    session.activeAgentName = "build";

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    expect(policy.disallowedTools).toContain("Bash");
  });
});
