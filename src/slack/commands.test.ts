import { describe, it, expect } from "bun:test";
import { parseCommand } from "./commands.ts";

describe("parseCommand", () => {
  it("parses a command with text", () => {
    expect(parseCommand("!build fix auth")).toEqual({
      command: "build",
      text: "fix auth",
    });
  });

  it("parses a command with no text (reset)", () => {
    expect(parseCommand("!reset")).toEqual({
      command: "reset",
      text: "",
    });
  });

  it("parses !review with no text", () => {
    expect(parseCommand("!review")).toEqual({
      command: "review",
      text: "",
    });
  });

  it("returns null command for unknown command", () => {
    expect(parseCommand("!unknown hello")).toEqual({
      command: null,
      text: "!unknown hello",
    });
  });

  it("returns null command for text without ! prefix", () => {
    expect(parseCommand("hello world")).toEqual({
      command: null,
      text: "hello world",
    });
  });

  it("handles empty string", () => {
    expect(parseCommand("")).toEqual({
      command: null,
      text: "",
    });
  });

  it("parses !build with no space (no trailing text)", () => {
    expect(parseCommand("!build")).toEqual({
      command: "build",
      text: "",
    });
  });

  describe("recognizes all 12 known commands", () => {
    const knownCommands = [
      "build",
      "frontend",
      "review",
      "architect",
      "reset",
      "status",
      "repo",
      "branch",
      "quiet",
      "verbose",
      "normal",
      "help",
    ];

    for (const cmd of knownCommands) {
      it(`recognizes !${cmd}`, () => {
        const result = parseCommand(`!${cmd}`);
        expect(result.command).toBe(cmd);
      });

      it(`recognizes !${cmd} with text`, () => {
        const result = parseCommand(`!${cmd} some argument`);
        expect(result.command).toBe(cmd);
        expect(result.text).toBe("some argument");
      });
    }

    it("has exactly 12 known commands", () => {
      expect(knownCommands).toHaveLength(12);
    });
  });

  it("trims trailing text", () => {
    expect(parseCommand("!build   fix auth  ")).toEqual({
      command: "build",
      text: "fix auth",
    });
  });

  it("returns full text as-is for unknown command with ! prefix", () => {
    expect(parseCommand("!foo bar baz")).toEqual({
      command: null,
      text: "!foo bar baz",
    });
  });
});
