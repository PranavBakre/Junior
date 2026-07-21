import { describe, it, expect } from "bun:test";
import { APPROVAL_PERMISSION_TOOL, buildClaudeArgs, juniorBaselinePrompt } from "./args.ts";
import type { ThreadSession } from "../session/types.ts";
import type { Config } from "../config.ts";
import type { AgentPermissions } from "../agents/loader.ts";

const CWD = "/work/repo";

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: "t1",
    channel: "C01",
    sessionId: null,
    leadSessionId: null,
    agentSessions: {},
    worktreePath: null,
    worktreePaths: {},
    targetRepo: null,
    baseRef: null,
    agentType: null,
    systemPrompt: null,
    status: "idle",
    pendingMessages: [],
    verbosity: "normal",
    muted: false,
    dormant: false,
    needsThreadCatchup: false,
    dormantAnnounced: false,
    humanParticipants: [],
    engagedHumans: [],
    model: null,
    cwd: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    driverMode: "headless",
    tmuxSessionName: null,
    topLevelTmuxAgent: null,
    idleInterruptCount: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config["claude"]> = {}): Config["claude"] {
  return {
    maxTurns: 25,
    timeoutMs: 300000,
    permissionMode: "bypassPermissions",
    defaultModel: null,
    // New parity knobs default OFF here so core-arg assertions stay focused;
    // dedicated tests below flip each one on.
    strictMcp: false,
    settingSources: "",
    approvalEnabled: false,
    maxBudgetUsd: null,
    baselineEnabled: false,
    defaultDriver: "headless",
    tmuxIdleTtlMs: 14_400_000,
    tmuxSweepIntervalMs: 900_000,
    ...overrides,
  };
}

function perms(overrides: Partial<AgentPermissions> = {}): AgentPermissions {
  return { intent: null, mcp: [], tools: [], ...overrides };
}

describe("buildClaudeArgs", () => {
  it("includes basic required args", () => {
    const args = buildClaudeArgs(makeSession(), "do something", makeConfig(), CWD);
    expect(args).toContain("-p");
    expect(args).toContain("do something");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("25");
    expect(args).toContain("--permission-mode");
    // No intent → normal branch → bypassPermissions.
    expect(args).toContain("bypassPermissions");
  });

  it("includes --resume when sessionId is present", () => {
    const session = makeSession({ sessionId: "sess-abc", sessionCwd: CWD });
    const args = buildClaudeArgs(session, "continue", makeConfig(), CWD);
    expect(args).toContain("--resume");
    expect(args).toContain("sess-abc");
  });

  it("does not resume a session created under another cwd", () => {
    const session = makeSession({
      sessionId: "sess-abc",
      sessionCwd: "/work/other-repo",
    });
    const args = buildClaudeArgs(session, "continue", makeConfig(), CWD);
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("sess-abc");
  });

  it("does not assume legacy sessions without cwd affinity are resumable", () => {
    const session = makeSession({ sessionId: "sess-legacy" });
    const args = buildClaudeArgs(session, "continue", makeConfig(), CWD);
    expect(args).not.toContain("--resume");
  });

  it("does not include --resume when sessionId is null", () => {
    const session = makeSession({ sessionId: null });
    const args = buildClaudeArgs(session, "start fresh", makeConfig(), CWD);
    expect(args).not.toContain("--resume");
  });

  it("includes --append-system-prompt when systemPrompt is set", () => {
    const session = makeSession({ systemPrompt: "You are a build agent." });
    const args = buildClaudeArgs(session, "build it", makeConfig(), CWD);
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("You are a build agent.");
  });

  it("does not include --append-system-prompt when systemPrompt is null and baseline off", () => {
    const session = makeSession({ systemPrompt: null });
    const args = buildClaudeArgs(session, "do it", makeConfig(), CWD);
    expect(args).not.toContain("--append-system-prompt");
  });

  it("uses maxTurns from config", () => {
    const config = makeConfig({ maxTurns: 10 });
    const args = buildClaudeArgs(makeSession(), "test", config, CWD);
    expect(args).toContain("--max-turns");
    expect(args).toContain("10");
  });

  it("uses permissionMode from config only for the utility intent", () => {
    const config = makeConfig({ permissionMode: "default" });
    const session = makeSession({ agentPermissions: perms({ intent: "utility" }) });
    const args = buildClaudeArgs(session, "test", config, CWD);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("default");
  });

  it("includes both --resume and --append-system-prompt when both are set", () => {
    const session = makeSession({
      sessionId: "sess-xyz",
      sessionCwd: CWD,
      systemPrompt: "Be concise.",
    });
    const args = buildClaudeArgs(session, "go", makeConfig(), CWD);
    expect(args).toContain("--resume");
    expect(args).toContain("sess-xyz");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("Be concise.");
  });

  it("uses config.defaultModel when session.model is null", () => {
    const config = makeConfig({ defaultModel: "claude-opus-4-6[1M]" });
    const args = buildClaudeArgs(makeSession(), "test", config, CWD);
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6[1M]");
  });

  it("prefers session.model over config.defaultModel", () => {
    const config = makeConfig({ defaultModel: "claude-opus-4-6[1M]" });
    const session = makeSession({ model: "haiku" });
    const args = buildClaudeArgs(session, "test", config, CWD);
    expect(args).toContain("--model");
    expect(args).toContain("haiku");
    expect(args).not.toContain("claude-opus-4-6[1M]");
  });

  it("omits --model when neither session nor config provides one", () => {
    const args = buildClaudeArgs(makeSession(), "test", makeConfig(), CWD);
    expect(args).not.toContain("--model");
  });

  it("places prompt immediately after -p", () => {
    const args = buildClaudeArgs(makeSession(), "my prompt", makeConfig(), CWD);
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(args[pIdx + 1]).toBe("my prompt");
  });

  // --- parity additions ---

  it("locks down writes for read-only intent", () => {
    const session = makeSession({ agentPermissions: perms({ intent: "read-only" }) });
    const args = buildClaudeArgs(session, "review", makeConfig(), CWD);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("Edit");
    expect(args).toContain("Write");
  });

  it("passes declared tools as --allowedTools", () => {
    const session = makeSession({
      agentPermissions: perms({ intent: "read-only", tools: ["Read", "Grep"] }),
    });
    const args = buildClaudeArgs(session, "look", makeConfig(), CWD);
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
    expect(args).toContain("Grep");
  });

  it("injects the Junior baseline prompt when baselineEnabled", () => {
    const args = buildClaudeArgs(makeSession(), "x", makeConfig({ baselineEnabled: true }), CWD);
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain(juniorBaselinePrompt());
  });

  it("adds --strict-mcp-config and --setting-sources when configured", () => {
    const config = makeConfig({ strictMcp: true, settingSources: "project" });
    const args = buildClaudeArgs(makeSession(), "x", config, CWD);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--setting-sources");
    expect(args).toContain("project");
  });

  it("wires the Slack approval round-trip for human-gated when approval enabled and slack-bot MCP present", () => {
    const session = makeSession({ agentPermissions: perms({ intent: "human-gated" }) });
    const args = buildClaudeArgs(session, "gate", makeConfig({ approvalEnabled: true }), CWD, "/tmp/mcp.json");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain(APPROVAL_PERMISSION_TOOL);
    // Approval needs `default` mode so un-allowed tools consult the prompt tool.
    const modeIdx = args.indexOf("--permission-mode");
    expect(args[modeIdx + 1]).toBe("default");
  });

  it("falls back to plan mode for human-gated when no MCP config is present (approval can't be wired)", () => {
    const session = makeSession({ agentPermissions: perms({ intent: "human-gated" }) });
    // No mcpConfigPath → slack-bot tool won't exist → don't advertise it.
    const args = buildClaudeArgs(session, "gate", makeConfig({ approvalEnabled: true }), CWD);
    expect(args).not.toContain("--permission-prompt-tool");
    const modeIdx = args.indexOf("--permission-mode");
    expect(args[modeIdx + 1]).toBe("plan");
  });

  it("keeps human-gated on plan mode when approval disabled", () => {
    const session = makeSession({ agentPermissions: perms({ intent: "human-gated" }) });
    const args = buildClaudeArgs(session, "gate", makeConfig({ approvalEnabled: false }), CWD, "/tmp/mcp.json");
    expect(args).not.toContain("--permission-prompt-tool");
    const modeIdx = args.indexOf("--permission-mode");
    expect(args[modeIdx + 1]).toBe("plan");
  });

  it("maps a GPT frontmatter model to its Claude equivalent", () => {
    const session = makeSession({ model: "gpt-5.5" });
    const args = buildClaudeArgs(session, "x", makeConfig(), CWD);
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).not.toContain("gpt-5.5");
  });

  it("honors an explicit model.claude override over the GPT map", () => {
    const session = makeSession({ model: "gpt-5.5", modelClaude: "sonnet" });
    const args = buildClaudeArgs(session, "x", makeConfig(), CWD);
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
    expect(args).not.toContain("opus");
  });

  it("adds --mcp-config when a path is provided", () => {
    const args = buildClaudeArgs(makeSession(), "x", makeConfig(), CWD, "/tmp/mcp.json");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/mcp.json");
  });

  it("adds --max-budget-usd when configured", () => {
    const args = buildClaudeArgs(makeSession(), "x", makeConfig({ maxBudgetUsd: 2.5 }), CWD);
    expect(args).toContain("--max-budget-usd");
    expect(args).toContain("2.5");
  });
});
