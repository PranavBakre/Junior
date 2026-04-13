import { describe, it, expect } from "bun:test";
import { buildClaudeArgs } from "./args.ts";
import type { ThreadSession } from "../session/types.ts";
import type { Config } from "../config.ts";

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: "t1",
    channel: "C01",
    sessionId: null,
    worktreePath: null,
    targetRepo: null,
    baseRef: null,
    agentType: null,
    systemPrompt: null,
    status: "idle",
    pendingMessages: [],
    verbosity: "normal",
    model: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config["claude"]> = {}): Config["claude"] {
  return {
    maxTurns: 25,
    timeoutMs: 300000,
    permissionMode: "bypassPermissions",
    ...overrides,
  };
}

describe("buildClaudeArgs", () => {
  it("includes basic required args", () => {
    const args = buildClaudeArgs(makeSession(), "do something", makeConfig());
    expect(args).toContain("-p");
    expect(args).toContain("do something");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("25");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
  });

  it("includes --resume when sessionId is present", () => {
    const session = makeSession({ sessionId: "sess-abc" });
    const args = buildClaudeArgs(session, "continue", makeConfig());
    expect(args).toContain("--resume");
    expect(args).toContain("sess-abc");
  });

  it("does not include --resume when sessionId is null", () => {
    const session = makeSession({ sessionId: null });
    const args = buildClaudeArgs(session, "start fresh", makeConfig());
    expect(args).not.toContain("--resume");
  });

  it("includes --append-system-prompt when systemPrompt is set", () => {
    const session = makeSession({ systemPrompt: "You are a build agent." });
    const args = buildClaudeArgs(session, "build it", makeConfig());
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("You are a build agent.");
  });

  it("does not include --append-system-prompt when systemPrompt is null", () => {
    const session = makeSession({ systemPrompt: null });
    const args = buildClaudeArgs(session, "do it", makeConfig());
    expect(args).not.toContain("--append-system-prompt");
  });

  it("uses maxTurns from config", () => {
    const config = makeConfig({ maxTurns: 10 });
    const args = buildClaudeArgs(makeSession(), "test", config);
    expect(args).toContain("--max-turns");
    expect(args).toContain("10");
  });

  it("uses permissionMode from config", () => {
    const config = makeConfig({ permissionMode: "default" });
    const args = buildClaudeArgs(makeSession(), "test", config);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("default");
  });

  it("includes both --resume and --append-system-prompt when both are set", () => {
    const session = makeSession({
      sessionId: "sess-xyz",
      systemPrompt: "Be concise.",
    });
    const args = buildClaudeArgs(session, "go", makeConfig());
    expect(args).toContain("--resume");
    expect(args).toContain("sess-xyz");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("Be concise.");
  });

  it("places prompt immediately after -p", () => {
    const args = buildClaudeArgs(makeSession(), "my prompt", makeConfig());
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(args[pIdx + 1]).toBe("my prompt");
  });
});
