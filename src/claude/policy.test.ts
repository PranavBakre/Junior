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
  test("generic read-only locks down writes and uses plan mode", () => {
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
    // Declared mutating tools must NOT be pre-allowed: under the approval
    // round-trip (default mode) --allowedTools skips the permission prompt,
    // which would bypass the human gate this intent exists for.
    expect(policy.allowedTools).toEqual(["Read"]);
    expect(policy.disallowedTools).toEqual([]);
    expect(policy.addDirs).toEqual(["/repo"]);
  });

  test("human-gated strips every mutating tool spec from the pre-allow list", () => {
    const session = sessionWith({
      intent: "human-gated",
      mcp: [],
      tools: ["Read", "Write", "Edit", "NotebookEdit", "Bash", "Bash(git *)", "Grep", "mcp__slack-bot__memory_recall"],
    });

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.allowedTools).toEqual(["Read", "Grep", "mcp__slack-bot__memory_recall"]);
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

    expect(policy.permissionMode).toBe("default");
    expect(policy.disallowedTools).toContain("Edit");
    expect(policy.disallowedTools).toContain("Write");
    expect(policy.allowedTools).toContain(
      "mcp__slack-bot__github_post_review",
    );
    expect(policy.allowedTools).toContain("Bash(gh pr view *)");
    expect(policy.allowedTools).not.toContain("Bash(git fetch *)");
  });

  test("review may run allowlisted checks only in a registered worktree", () => {
    const session = createSession("t", "c");
    session.activeAgentName = "review";
    session.worktreePath = "/repo/.junior-worktrees/review";
    session.worktreePaths = {
      backend: "/repo/.junior-worktrees/review",
      expo: "/expo/.junior-worktrees/review",
    };
    session.verificationPackageManager = "pnpm";
    session.agentPermissions = {
      intent: "read-only",
      mcp: [],
      tools: ["Read", "Write", "Bash(git *)"],
    };

    const policy = mapClaudeRunPolicy({
      config,
      session,
      cwd: session.worktreePath,
    });

    expect(policy.permissionMode).toBe("default");
    expect(policy.allowedTools).toContain("Bash(pnpm test *)");
    expect(policy.allowedTools).not.toContain("Bash(npm test *)");
    expect(policy.allowedTools).not.toContain("Bash(bun test *)");
    expect(policy.allowedTools).not.toContain("Bash(git *)");
    expect(policy.allowedTools).not.toContain("Write");
    expect(policy.disallowedTools).toContain("Write");
    expect(policy.addDirs).toContain("/expo/.junior-worktrees/review");
  });

  test("review gets safe inspection only when cwd is not a registered worktree", () => {
    const session = createSession("t", "c");
    session.activeAgentName = "review";
    session.worktreePath = "/registered-worktree";
    session.verificationPackageManager = "npm";
    session.agentPermissions = { intent: "read-only", mcp: [], tools: ["Read"] };

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/shared-repo" });

    expect(policy.permissionMode).toBe("default");
    expect(policy.allowedTools).toContain("Bash(gh pr view *)");
    expect(policy.allowedTools).not.toContain("Bash(git fetch *)");
    expect(policy.allowedTools).not.toContain("Bash(gh pr checkout *)");
    expect(policy.allowedTools).not.toContain("Bash(npm test *)");
  });

  test("review keeps inspection tools when package-manager metadata is ambiguous", () => {
    const session = createSession("t", "c");
    session.activeAgentName = "review";
    session.worktreePath = "/registered-worktree";
    session.agentPermissions = { intent: "read-only", mcp: [], tools: ["Read"] };

    const policy = mapClaudeRunPolicy({
      config,
      session,
      cwd: session.worktreePath,
    });

    expect(policy.permissionMode).toBe("default");
    expect(policy.allowedTools).toContain("Bash(git blame *)");
    expect(policy.allowedTools).toContain("Bash(gh pr list *)");
    expect(policy.allowedTools.some((tool) => tool.startsWith("Bash(gh api"))).toBe(false);
    expect(policy.allowedTools).not.toContain("Bash(gh pr checkout *)");
    expect(policy.allowedTools).not.toContain("Bash(npm test *)");
  });

  test("does not grant the review-comment write surface to other read-only roles", () => {
    const session = createSession("t", "c");
    session.activeAgentName = "reproducer";
    session.agentPermissions = { intent: null, mcp: [], tools: ["Read"] };

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    expect(policy.allowedTools).not.toContain(
      "mcp__slack-bot__github_post_review",
    );
  });

  test("missing intent fails closed for pm/architect roles", () => {
    const session = createSession("t", "c");
    session.activeAgentName = "pm";
    session.agentPermissions = { intent: null, mcp: [], tools: ["Read", "Write"] };

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("plan");
    // Write is declared but human-gated must not pre-allow it.
    expect(policy.allowedTools).toEqual(["Read"]);
  });

  test("declared intent cannot widen catalog ceiling for restricted roles", () => {
    // Phase 3: target-repo / session overrides must not grant review product-code writes.
    const session = sessionWith({ intent: "normal", mcp: [], tools: [] });
    session.activeAgentName = "review";

    const policy = mapClaudeRunPolicy({ config, session, cwd: "/repo" });

    expect(policy.permissionMode).toBe("default");
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
