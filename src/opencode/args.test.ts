import { describe, expect, it } from "bun:test";
import { buildOpenCodeArgs } from "./args.ts";

describe("buildOpenCodeArgs", () => {
  it("builds fresh run args", () => {
    expect(
      buildOpenCodeArgs({
        cwd: "/repo/worktree",
        agentName: "junior",
        prompt: "fix it",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      "/repo/worktree",
      "--agent",
      "junior",
      "fix it",
    ]);
  });

  it("builds resume args with session id", () => {
    const args = buildOpenCodeArgs({
      cwd: "/repo/worktree",
      agentName: "junior",
      sessionId: "ses_123",
      prompt: "continue",
    });

    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe("ses_123");
    expect(args).not.toContain("--continue");
    expect(args.at(-1)).toBe("continue");
  });

  it("adds model before prompt and file attachments after prompt", () => {
    expect(
      buildOpenCodeArgs({
        cwd: "/repo/worktree",
        agentName: "reviewer",
        model: "openai/gpt-5.1",
        files: ["/tmp/a.png", "/tmp/b.txt"],
        prompt: "inspect files",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      "/repo/worktree",
      "--agent",
      "reviewer",
      "--model",
      "openai/gpt-5.1",
      "inspect files",
      "--file",
      "/tmp/a.png",
      "--file",
      "/tmp/b.txt",
    ]);
  });

  it("keeps prompt before files so OpenCode does not parse prompt as a file", () => {
    const prompt = "<identity>\nsecret prompt context\n</identity>";
    const args = buildOpenCodeArgs({
      cwd: "/repo/worktree",
      agentName: "junior",
      files: ["/tmp/image.png"],
      prompt,
    });

    expect(args.indexOf(prompt)).toBeLessThan(args.indexOf("--file"));
  });
});
