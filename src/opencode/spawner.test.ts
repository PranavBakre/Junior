import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { spawnOpenCode } from "./spawner.ts";

describe("spawnOpenCode", () => {
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
    expect(parsed.agent["sentry-fetch"].mode).toBe("subagent");
    expect(parsed.agent["vercel-status"].mode).toBe("subagent");
    expect(parsed.agent.reproducer).toBeUndefined();
  });
});
