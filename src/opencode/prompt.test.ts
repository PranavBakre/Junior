import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  buildOpenCodeAgentPrompt,
  FALLBACK_JUNIOR_CORE_PROMPT,
  OPENCODE_JUNIOR_CORE_PROMPT,
  OPENCODE_PROVIDER_AGENT,
  OPENCODE_PROVIDER_BASE_PROMPT,
} from "./prompt.ts";

describe("buildOpenCodeAgentPrompt", () => {
  it("uses the native OpenCode build provider agent", () => {
    expect(OPENCODE_PROVIDER_AGENT).toBe("build");
  });

  it("keeps the fallback Junior core prompt in sync with the bundled core file", () => {
    expect(FALLBACK_JUNIOR_CORE_PROMPT).toBe(OPENCODE_JUNIOR_CORE_PROMPT);
  });

  it("returns a complete provider baseline even without a Junior prompt", () => {
    const prompt = buildOpenCodeAgentPrompt();

    expect(prompt).toContain(OPENCODE_PROVIDER_BASE_PROMPT);
    expect(prompt).toContain("Slack-controlled coding agent");
    expect(prompt).toContain("Preserve Junior's orchestration model");
    expect(prompt).toContain("<junior-core>");
    expect(prompt).toContain("## First step: infer the required action");
    expect(prompt).toContain("<junior-active-agent>default</junior-active-agent>");
    expect(prompt).not.toContain("<junior-agent-prompt>");
  });

  it("wraps the active Junior agent prompt after the provider baseline", () => {
    const prompt = buildOpenCodeAgentPrompt({
      juniorAgentName: "lead",
      juniorPrompt: "You are the lead persona.",
    });

    expect(prompt.indexOf(OPENCODE_PROVIDER_BASE_PROMPT)).toBe(0);
    expect(prompt).toContain("<junior-core>");
    expect(prompt).toContain("<junior-active-agent>lead</junior-active-agent>");
    expect(prompt).toContain("<junior-agent-prompt>");
    expect(prompt).toContain("You are the lead persona.");
    expect(prompt).toContain("</junior-agent-prompt>");
  });

  it("does not duplicate the bundled Junior core when the dynamic prompt already starts with it", () => {
    const prompt = buildOpenCodeAgentPrompt({
      juniorPrompt: `${OPENCODE_JUNIOR_CORE_PROMPT}\n\n# build\n\nBuild body.`,
    });

    expect(prompt.match(/## First step: infer the required action/g)).toHaveLength(1);
    expect(prompt).toContain("# build");
  });
});

describe("static OpenCode agents", () => {
  it("are marked as manual-dev prompts, not Junior Slack runtime prompts", () => {
    const agentsDir = new URL("../../.opencode/agents/", import.meta.url);
    const agentFiles = readdirSync(agentsDir).filter((name) => name.endsWith(".md"));

    expect(agentFiles.length).toBeGreaterThan(0);
    for (const name of agentFiles) {
      const content = readFileSync(new URL(name, agentsDir), "utf8");
      expect(content).toContain(
        "Manual-dev prompt only. Junior Slack runtime uses generated `agent.build.prompt`.",
      );
    }
  });
});
