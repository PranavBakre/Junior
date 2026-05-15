import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { spawnOpenCode } from "./spawner.ts";

describe("spawnOpenCode", () => {
  it("generates OPENCODE_CONFIG_CONTENT with provider baseline plus Junior prompt", async () => {
    const session = createSession("thread-1", "C01");
    session.systemPrompt = "You are the review persona.";
    session.activeAgentName = "review";

    let configContent: string | undefined;
    const handle = spawnOpenCode(
      session,
      "inspect this",
      {
        command: "/usr/bin/true",
        env: (env) => {
          configContent = env.OPENCODE_CONFIG_CONTENT;
        },
      },
    );

    await handle.result;

    expect(configContent).toBeDefined();
    const parsed = JSON.parse(configContent!);
    const prompt = parsed.agent.build.prompt as string;

    expect(prompt).toContain("Slack-controlled coding agent");
    expect(prompt).toContain("<junior-system-prompt>");
    expect(prompt).toContain("You are the review persona.");
  });
});
