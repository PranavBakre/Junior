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
    dormant: false,
    dormantAnnounced: false,
    humanParticipants: [],
    model: null,
    cwd: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    driverMode: "headless",
    tmuxSessionName: null,
    topLevelTmuxAgent: null,
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

  it("omits JUNIOR_SLACK_ICON_EMOJI when identity has no iconEmoji (default agent)", () => {
    const env = buildRunnerEnv(
      makeSession({ activeAgentName: "default" }),
      "xoxb-test",
      { username: "Junior" },
    );

    expect(env.JUNIOR_SLACK_USERNAME).toBe("Junior");
    expect(env.JUNIOR_SLACK_ICON_EMOJI).toBeUndefined();
  });

  it("clears inherited Junior Slack identity env when not explicitly set", () => {
    const previousUsername = process.env.JUNIOR_SLACK_USERNAME;
    const previousIcon = process.env.JUNIOR_SLACK_ICON_EMOJI;
    process.env.JUNIOR_SLACK_USERNAME = "Stale Agent";
    process.env.JUNIOR_SLACK_ICON_EMOJI = ":face_with_cowboy_hat:";

    try {
      const defaultEnv = buildRunnerEnv(
        makeSession({ activeAgentName: "default" }),
        "xoxb-test",
        { username: "Junior" },
      );
      expect(defaultEnv.JUNIOR_SLACK_USERNAME).toBe("Junior");
      expect(defaultEnv.JUNIOR_SLACK_ICON_EMOJI).toBeUndefined();

      const noIdentityEnv = buildRunnerEnv(
        makeSession({ activeAgentName: "lead" }),
        "xoxb-test",
      );
      expect(noIdentityEnv.JUNIOR_SLACK_USERNAME).toBeUndefined();
      expect(noIdentityEnv.JUNIOR_SLACK_ICON_EMOJI).toBeUndefined();
    } finally {
      if (previousUsername === undefined) {
        delete process.env.JUNIOR_SLACK_USERNAME;
      } else {
        process.env.JUNIOR_SLACK_USERNAME = previousUsername;
      }
      if (previousIcon === undefined) {
        delete process.env.JUNIOR_SLACK_ICON_EMOJI;
      } else {
        process.env.JUNIOR_SLACK_ICON_EMOJI = previousIcon;
      }
    }
  });
});
