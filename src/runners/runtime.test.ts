import { describe, expect, it } from "bun:test";
import type { ThreadSession } from "../session/types.ts";
import {
  buildRunnerEnv,
  needsProjectMcp,
  isProviderSessionUnavailable,
  normalizeProviderSessionCwd,
  providerSessionMatchesCwd,
  resolveRunnerCwd,
  willResume,
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

describe("willResume", () => {
  it("is false without a session id", () => {
    expect(
      willResume({
        provider: "claude",
        sessionId: null,
        opencodeContinuityEnabled: true,
      }),
    ).toBe(false);
  });

  it("resumes claude when a session id is present", () => {
    expect(
      willResume({
        provider: "claude",
        sessionId: "ses_1",
        opencodeContinuityEnabled: false,
      }),
    ).toBe(true);
  });

  it("does not resume opencode when continuity is disabled", () => {
    expect(
      willResume({
        provider: "opencode",
        sessionId: "ses_1",
        opencodeContinuityEnabled: false,
      }),
    ).toBe(false);
    expect(
      willResume({
        provider: "opencode-sdk",
        sessionId: "ses_1",
        opencodeContinuityEnabled: false,
      }),
    ).toBe(false);
  });

  it("resumes opencode only when continuity is enabled", () => {
    expect(
      willResume({
        provider: "opencode",
        sessionId: "ses_1",
        opencodeContinuityEnabled: true,
      }),
    ).toBe(true);
  });
});

describe("runner runtime", () => {
  it("matches Claude sessions only to their creation cwd", () => {
    expect(providerSessionMatchesCwd({
      provider: "claude",
      sessionId: "ses_1",
      sessionCwd: "/tmp/repo/.",
      cwd: "/tmp/repo",
    })).toBe(true);
    expect(providerSessionMatchesCwd({
      provider: "claude",
      sessionId: "ses_1",
      sessionCwd: "/tmp/repo-a",
      cwd: "/tmp/repo-b",
    })).toBe(false);
    expect(providerSessionMatchesCwd({
      provider: "claude",
      sessionId: "ses_1",
      sessionCwd: null,
      cwd: "/tmp/repo",
    })).toBe(false);
  });

  it("recognizes only provider-originated missing Claude conversations", () => {
    expect(isProviderSessionUnavailable(
      "claude",
      "No conversation found with session ID: ses_1",
    )).toBe(true);
    expect(isProviderSessionUnavailable(
      "opencode",
      "No conversation found with session ID: ses_1",
    )).toBe(false);
    expect(normalizeProviderSessionCwd("/tmp/repo/.")).toBe("/tmp/repo");
  });

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
    expect(env.JUNIOR_SLACK_ICON_URL).toBeUndefined();
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test");
  });

  it("never exposes the MCP context signing secret to child runners", () => {
    const previous = process.env.MCP_CONTEXT_SECRET;
    process.env.MCP_CONTEXT_SECRET = "parent-only-secret";
    try {
      const env = buildRunnerEnv(
        makeSession({ activeAgentName: "review" }),
        "xoxb-test",
      );
      expect(env.MCP_CONTEXT_SECRET).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.MCP_CONTEXT_SECRET;
      else process.env.MCP_CONTEXT_SECRET = previous;
    }
  });

  it("never exposes direct database credentials to child runners", () => {
    const keys = [
      "MDB_MCP_CONNECTION_STRING",
      "DB_STRING",
      "MONGODB_URI",
      "MONGO_URI",
      "MONGODB_URL",
      "MONGO_URL",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = `mongodb://unsafe/${key}`;

    try {
      const env = buildRunnerEnv(
        makeSession({ activeAgentName: "default" }),
        "xoxb-test",
      );
      for (const key of keys) expect(env[key]).toBeUndefined();
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("sets JUNIOR_SLACK_ICON_URL for image URL identities", () => {
    const env = buildRunnerEnv(
      makeSession({ activeAgentName: "github-access" }),
      "xoxb-test",
      { username: "GitHub Access", imageUrl: "https://example.com/icon.png" },
    );

    expect(env.JUNIOR_SLACK_USERNAME).toBe("GitHub Access");
    expect(env.JUNIOR_SLACK_ICON_URL).toBe("https://example.com/icon.png");
    expect(env.JUNIOR_SLACK_ICON_EMOJI).toBeUndefined();
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
    const previousIconUrl = process.env.JUNIOR_SLACK_ICON_URL;
    process.env.JUNIOR_SLACK_USERNAME = "Stale Agent";
    process.env.JUNIOR_SLACK_ICON_EMOJI = ":face_with_cowboy_hat:";
    process.env.JUNIOR_SLACK_ICON_URL = "https://example.com/stale.png";

    try {
      const defaultEnv = buildRunnerEnv(
        makeSession({ activeAgentName: "default" }),
        "xoxb-test",
        { username: "Junior" },
      );
      expect(defaultEnv.JUNIOR_SLACK_USERNAME).toBe("Junior");
      expect(defaultEnv.JUNIOR_SLACK_ICON_EMOJI).toBeUndefined();
      expect(defaultEnv.JUNIOR_SLACK_ICON_URL).toBeUndefined();

      const noIdentityEnv = buildRunnerEnv(
        makeSession({ activeAgentName: "lead" }),
        "xoxb-test",
      );
      expect(noIdentityEnv.JUNIOR_SLACK_USERNAME).toBeUndefined();
      expect(noIdentityEnv.JUNIOR_SLACK_ICON_EMOJI).toBeUndefined();
      expect(noIdentityEnv.JUNIOR_SLACK_ICON_URL).toBeUndefined();
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
      if (previousIconUrl === undefined) {
        delete process.env.JUNIOR_SLACK_ICON_URL;
      } else {
        process.env.JUNIOR_SLACK_ICON_URL = previousIconUrl;
      }
    }
  });
});
