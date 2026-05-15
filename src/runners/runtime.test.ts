import { describe, expect, it } from "bun:test";
import type { ThreadSession } from "../session/types.ts";
import {
  buildRunnerEnv,
  needsProjectMcp,
  resolveRunnerCwd,
} from "./runtime.ts";

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
    model: null,
    cwd: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("runner runtime", () => {
  it("resolves cwd using session override first", () => {
    const session = makeSession({
      cwd: "/tmp/junior-utility",
      worktreePath: "/tmp/worktree",
    });

    expect(resolveRunnerCwd(session, "/tmp/repo")).toBe("/tmp/junior-utility");
  });

  it("resolves cwd using worktree before target repo fallback", () => {
    const session = makeSession({ worktreePath: "/tmp/worktree" });

    expect(resolveRunnerCwd(session, "/tmp/repo")).toBe("/tmp/worktree");
  });

  it("skips project MCP for utility cwd overrides", () => {
    const session = makeSession({ cwd: "/tmp/junior-utility" });

    expect(needsProjectMcp(session, "/tmp/junior-utility")).toBe(false);
  });

  it("uses project MCP for worktree-backed runs", () => {
    const session = makeSession({ worktreePath: "/tmp/worktree" });

    expect(needsProjectMcp(session, "/tmp/worktree")).toBe(true);
  });

  it("builds the required Junior and Slack env vars", () => {
    const env = buildRunnerEnv(
      makeSession({ activeAgentName: "reviewer" }),
      "xoxb-test",
      { username: "Reviewer", iconEmoji: ":eyes:" },
    );

    expect(env.JUNIOR_SPAWNED).toBe("1");
    expect(env.SLACK_CHANNEL).toBe("C01");
    expect(env.SLACK_THREAD_TS).toBe("t1");
    expect(env.JUNIOR_AGENT_NAME).toBe("reviewer");
    expect(env.JUNIOR_SLACK_USERNAME).toBe("Reviewer");
    expect(env.JUNIOR_SLACK_ICON_EMOJI).toBe(":eyes:");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test");
  });
});
