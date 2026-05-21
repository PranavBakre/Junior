import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import { runWorklogJob } from "./job.ts";
import type { RunCommand } from "./activity.ts";

describe("runWorklogJob", () => {
  it("writes a doc and posts the generated summary to Slack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-worklog-test-"));
    const posts: Array<Record<string, unknown>> = [];
    const app = {
      client: {
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            posts.push(args);
            return { ok: true, ts: "1.2" };
          },
        },
      },
    } as unknown as App;
    const config = makeConfig({
      docsDir: dir,
      useAgent: true,
    });
    const runCommand: RunCommand = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "git config --get user.email") {
        return { exitCode: 0, stdout: "me@example.com\n", stderr: "" };
      }
      if (key.startsWith("git log ")) {
        return {
          exitCode: 0,
          stdout: "abc\x1fabc\x1f2026-05-21T08:00:00Z\x1fwire worklog cron\n",
          stderr: "",
        };
      }
      if (key === "git remote get-url origin") {
        return { exitCode: 0, stdout: "https://github.com/acme/app.git\n", stderr: "" };
      }
      if (key === "gh api user --jq .login") {
        return { exitCode: 0, stdout: "pranav\n", stderr: "" };
      }
      if (key.startsWith("gh pr list ")) {
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected ${key}` };
    };

    try {
      const result = await runWorklogJob({
        app,
        config,
        now: new Date("2026-05-21T12:00:00.000Z"),
        runCommand,
        summarizeWithAgent: async () => "*Worklog* :white_check_mark:\n> Cron\n- Added worklog digest",
      });

      expect(result.posted).toBe(true);
      expect(posts).toEqual([
        {
          channel: "C123",
          thread_ts: "123.456",
          text: "*Worklog* :white_check_mark:\n> Cron\n- Added worklog digest",
        },
      ]);
      expect(readFileSync(result.docPath, "utf8")).toContain("Added worklog digest");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeConfig(worklog: Partial<Config["worklog"]>): Config {
  return {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "",
    },
    claude: {
      maxTurns: 25,
      timeoutMs: 300000,
      permissionMode: "bypassPermissions",
      defaultModel: null,
      defaultDriver: "headless",
      tmuxIdleTtlMs: 1000,
      tmuxSweepIntervalMs: 1000,
    },
    runner: { provider: "opencode" },
    opencode: {
      model: null,
      timeoutMs: 300000,
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
    },
    repos: [{ name: "app", path: "/repo", defaultBase: "main" }],
    session: {
      staleTimeoutMs: 86400000,
      cleanupIntervalMs: 900000,
      store: "memory",
      sqlitePath: "data/sessions.db",
      homeWindowMs: 172800000,
      defaultVerbosity: "normal",
    },
    channelDefaults: {},
    adminSlackUserId: null,
    http: { enabled: false, port: 0 },
    worklog: {
      enabled: true,
      channel: "C123",
      threadTs: "123.456",
      dailyAt: "18:00",
      lookbackHours: 24,
      docsDir: "docs/worklog",
      gitAuthor: null,
      githubUser: null,
      useAgent: true,
      runOnStartup: false,
      ...worklog,
    },
  };
}
