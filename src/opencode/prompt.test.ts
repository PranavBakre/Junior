import { describe, expect, it } from "bun:test";
import {
  OPENCODE_PROVIDER_BASE_PROMPT,
  buildOpenCodeAgentPrompt,
} from "./prompt.ts";

describe("buildOpenCodeAgentPrompt", () => {
  it("returns the provider baseline when no Junior prompt is present", () => {
    const prompt = buildOpenCodeAgentPrompt();

    expect(prompt).toBe(OPENCODE_PROVIDER_BASE_PROMPT);
    expect(prompt).toContain("Slack-controlled coding agent");
    expect(prompt).toContain("Read the relevant code before changing it");
  });

  it("appends Junior's dynamic system prompt after the provider baseline", () => {
    const prompt = buildOpenCodeAgentPrompt({
      juniorPrompt: "You are the review persona.",
    });

    expect(prompt.indexOf(OPENCODE_PROVIDER_BASE_PROMPT)).toBe(0);
    expect(prompt).toContain("<junior-system-prompt>");
    expect(prompt).toContain("You are the review persona.");
    expect(prompt).toContain("</junior-system-prompt>");
  });

  it("trims blank persona prompts instead of emitting empty persona tags", () => {
    expect(buildOpenCodeAgentPrompt({ juniorPrompt: "  \n " })).toBe(
      OPENCODE_PROVIDER_BASE_PROMPT,
    );
  });
});
