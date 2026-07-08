import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../session/types.ts";
import { spawnOpenCode } from "./spawner.ts";

describe("spawnOpenCode", () => {
  it("does not resume native sessions unless continuity is enabled", async () => {
    const session = createSession("thread-1", "C01");
    session.provider = "opencode";
    session.sessionId = "ses_existing";
    const capture = createArgCaptureCommand();

    try {
      const handle = spawnOpenCode(session, "start fresh", {
        command: capture.command,
        env: { JUNIOR_TEST_CAPTURE_ARGS: capture.outputPath },
      });

      await handle.result;

      expect(capture.readArgs()).not.toContain("--session");
    } finally {
      capture.cleanup();
    }
  });

  it("passes native session id when continuity is enabled", async () => {
    const session = createSession("thread-1", "C01");
    session.provider = "opencode";
    session.sessionId = "ses_existing";
    const capture = createArgCaptureCommand();

    try {
      const handle = spawnOpenCode(session, "continue", {
        command: capture.command,
        continuityEnabled: true,
        env: { JUNIOR_TEST_CAPTURE_ARGS: capture.outputPath },
      });

      await handle.result;

      const args = capture.readArgs();
      expect(args).toContain("--session");
      expect(args[args.indexOf("--session") + 1]).toBe("ses_existing");
    } finally {
      capture.cleanup();
    }
  });

  it("generates runtime config for provider agent build while preserving Junior active agent in the prompt", async () => {
    const session = createSession("thread-1", "C01");
    session.provider = "opencode";
    session.systemPrompt = "You are the review persona.";
    session.activeAgentName = "review";

    let configContent: string | undefined;
    let envJuniorAgentName: string | undefined;
    const handle = spawnOpenCode(
      session,
      "inspect this",
      {
        command: "/usr/bin/true",
        env: (_env, context) => {
          configContent = _env.OPENCODE_CONFIG_CONTENT;
          envJuniorAgentName = context.juniorAgentName;
        },
      },
    );

    await handle.result;

    expect(envJuniorAgentName).toBe("review");
    expect(configContent).toBeDefined();
    const parsed = JSON.parse(configContent!);

    expect(parsed.agent.build).toBeDefined();
    const prompt = parsed.agent.build.prompt as string;
    expect(prompt).toContain("Slack-controlled coding agent");
    expect(prompt).toContain("<junior-core>");
    expect(prompt).toContain("## First step: infer the required action");
    expect(prompt).toContain("<junior-active-agent>review</junior-active-agent>");
    expect(prompt).toContain("<junior-agent-prompt>");
    expect(prompt).toContain("You are the review persona.");
  });

  it("uses agentType as the Junior active role when both session role fields exist", async () => {
    const session = createSession("thread-1", "C01");
    session.provider = "opencode";
    session.systemPrompt = "You are the build persona.";
    session.agentType = "build";
    session.activeAgentName = "default";

    let configContent: string | undefined;
    const handle = spawnOpenCode(
      session,
      "implement this",
      {
        command: "/usr/bin/true",
        env: (_env) => {
          configContent = _env.OPENCODE_CONFIG_CONTENT;
        },
      },
    );

    await handle.result;

    const parsed = JSON.parse(configContent!);
    const prompt = parsed.agent.build.prompt as string;
    expect(prompt).toContain("<junior-active-agent>build</junior-active-agent>");
  });

  it("includes Slack MCP for non-utility root runs", async () => {
    const session = createSession("thread-1", "C01");
    session.provider = "opencode";

    let configContent: string | undefined;
    const handle = spawnOpenCode(
      session,
      "intake bug",
      {
        command: "/usr/bin/true",
        mcp: {
          "slack-bot": {
            type: "remote",
            url: "http://localhost:3456/mcp",
            enabled: true,
          },
        },
        env: (_env) => {
          configContent = _env.OPENCODE_CONFIG_CONTENT;
        },
      },
    );

    await handle.result;

    const parsed = JSON.parse(configContent!);
    expect(parsed.mcp["slack-bot"]).toEqual({
      type: "remote",
      url: "http://localhost:3456/mcp",
      enabled: true,
    });
  });

  it("keeps the MCP carve-out for utility cwd overrides", async () => {
    const session = createSession("thread-1", "C01");
    session.provider = "opencode";
    session.cwd = "/tmp/junior-utility";

    let configContent: string | undefined;
    const handle = spawnOpenCode(
      session,
      "update calendar",
      {
        command: "/usr/bin/true",
        mcp: {
          "slack-bot": {
            type: "remote",
            url: "http://localhost:3456/mcp",
            enabled: true,
          },
        },
        env: (_env) => {
          configContent = _env.OPENCODE_CONFIG_CONTENT;
        },
      },
    );

    await handle.result;

    const parsed = JSON.parse(configContent!);
    expect(parsed.mcp).toBeUndefined();
    expect(parsed.agent["nr-research"]).toBeUndefined();
    expect(parsed.agent["sentry-fetch"]).toBeUndefined();
    expect(parsed.agent["vercel-status"]).toBeUndefined();
  });

  it("exposes stateless support agents to OpenCode Task", async () => {
    const session = createSession("thread-1", "C01");
    session.provider = "opencode";

    let configContent: string | undefined;
    const handle = spawnOpenCode(
      session,
      "run observability",
      {
        command: "/usr/bin/true",
        env: (_env) => {
          configContent = _env.OPENCODE_CONFIG_CONTENT;
        },
      },
    );

    await handle.result;

    const parsed = JSON.parse(configContent!);
    expect(parsed.agent["nr-research"].mode).toBe("subagent");
    expect(parsed.agent["nr-research"].permission).toEqual({
      read: "allow",
      glob: "allow",
      grep: "allow",
      edit: "deny",
      write: "deny",
      bash: "deny",
      task: "deny",
      "mcp__*": "allow",
    });
    expect(parsed.agent["sentry-fetch"].mode).toBe("subagent");
    expect(parsed.agent["vercel-status"].mode).toBe("subagent");
    expect(parsed.agent.reproducer).toBeUndefined();
  });

  it("captures sessionId from init event before SIGINT — simulates idle-interrupt recovery", async () => {
    // This test verifies the idle-interrupt recovery path:
    // 1. OpenCode spawns, emits step_start with sessionID, then hangs
    // 2. Junior sends SIGINT (simulating idle timeout)
    // 3. The result.sessionId is captured from the init event — available for retry
    //    with --session to resume conversation context
    const session = createSession("thread-int", "C01");
    session.provider = "opencode";

    const { command, cleanup } = createHungOpenCodeScript("ses_hung_123");

    try {
      const handle = spawnOpenCode(session, "long running task", {
        command,
        continuityEnabled: true,
      });

      // Wait for the init event, then send SIGINT to simulate idle interrupt
      const initPromise = new Promise<{ sessionId: string }>((resolve) => {
        handle.onEvent((event) => {
          if (event.type === "init") {
            resolve({ sessionId: event.sessionId });
          }
        });
      });

      const initEvent = await initPromise;
      expect(initEvent.sessionId).toBe("ses_hung_123");

      // Simulate idle timeout: send SIGINT
      handle.kill("SIGINT");

      const result = await handle.result;

      // SessionId must be available so the retry spawn can pass --session
      expect(result.sessionId).toBe("ses_hung_123");
      // Non-zero exit expected after SIGINT
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanup();
    }
  });

  it("surfaces the native error event message when opencode exits non-zero with empty stderr", async () => {
    const session = createSession("thread-err", "C01");
    session.provider = "opencode";

    const { command, cleanup } = createErroringOpenCodeScript();

    try {
      const handle = spawnOpenCode(session, "trigger error", { command });
      const result = await handle.result;

      expect(result.exitCode).not.toBe(0);
      expect(result.error).toBe(
        "UnknownError: Unexpected server error. Check server logs for details. (ref: abc123)",
      );
    } finally {
      cleanup();
    }
  });

});

function createErroringOpenCodeScript(): {
  command: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "junior-opencode-err-"));
  const command = join(dir, "erroring-opencode.sh");
  // Mirrors a slashless-model crash: opencode emits a native error event on
  // stdout and exits 1 with an empty stderr.
  writeFileSync(
    command,
    `#!/bin/sh
echo '{"type":"error","timestamp":123,"sessionID":"ses_err","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"abc123"}}}'
exit 1
`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function createHungOpenCodeScript(sessionId: string): {
  command: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "junior-opencode-hung-"));
  const command = join(dir, "hung-opencode.sh");
  writeFileSync(
    command,
    `#!/bin/sh
# Emit a step_start with sessionID, then hang until killed
echo '{"type":"step_start","sessionID":"${sessionId}"}'
# Wait indefinitely — stdout is buffered, so flush
trap 'exit 130' INT TERM
while true; do sleep 1; done
`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function createArgCaptureCommand(): {
  command: string;
  outputPath: string;
  readArgs: () => string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "junior-opencode-args-"));
  const command = join(dir, "capture-args.sh");
  const outputPath = join(dir, "args.txt");
  writeFileSync(
    command,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$JUNIOR_TEST_CAPTURE_ARGS"\n',
  );
  chmodSync(command, 0o755);

  return {
    command,
    outputPath,
    readArgs: () => readFileSync(outputPath, "utf8").trim().split("\n"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
