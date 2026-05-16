import { describe, expect, it } from "bun:test";
import {
  buildOpenCodeConfig,
  buildOpenCodeConfigContent,
} from "./config.ts";

describe("OpenCode config generation", () => {
  it("generates config with model, permission, and primary agent prompt", () => {
    expect(
      buildOpenCodeConfig({
        agentName: "build",
        agentPrompt: "CUSTOM JUNIOR SYSTEM PROMPT",
        model: "openai/gpt-5.1",
        permission: "allow",
      }),
    ).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "openai/gpt-5.1",
      permission: "allow",
      agent: {
        build: {
          description: "Junior Slack runner",
          mode: "primary",
          permission: { "*": "allow" },
          prompt: "CUSTOM JUNIOR SYSTEM PROMPT",
        },
      },
    });
  });

  it("includes optional MCP entries", () => {
    const config = buildOpenCodeConfig({
      agentName: "build",
      agentPrompt: "Prompt",
      mcp: {
        "slack-bot": {
          type: "remote",
          url: "http://localhost:3456/mcp",
          enabled: true,
        },
        playwright: {
          type: "local",
          command: ["npx", "@playwright/mcp", "--headless"],
          enabled: true,
        },
      },
    });

    expect(config.mcp?.["slack-bot"]).toEqual({
      type: "remote",
      url: "http://localhost:3456/mcp",
      enabled: true,
    });
    expect(config.mcp?.playwright?.command).toEqual([
      "npx",
      "@playwright/mcp",
      "--headless",
    ]);
  });

  it("serializes OPENCODE_CONFIG_CONTENT JSON", () => {
    const content = buildOpenCodeConfigContent({
      agentName: "build",
      agentPrompt: "Prompt",
      permission: { edit: "deny" },
    });

    expect(JSON.parse(content)).toMatchObject({
      permission: { edit: "deny" },
      agent: {
        build: {
          permission: { edit: "deny" },
          prompt: "Prompt",
        },
      },
    });
  });

  it("copies string permission onto the generated agent as an object override", () => {
    const config = buildOpenCodeConfig({
      agentName: "build",
      agentPrompt: "Prompt",
      permission: "allow",
    });

    expect(config.permission).toBe("allow");
    expect(config.agent.build.permission).toEqual({ "*": "allow" });
  });

  it("rejects blank agent names", () => {
    expect(() =>
      buildOpenCodeConfig({
        agentName: " ",
        agentPrompt: "Prompt",
      }),
    ).toThrow("OpenCode agentName is required");
  });
});
