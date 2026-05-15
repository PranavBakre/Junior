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

  it("does NOT parse !review as a command (review is a persistent-agent directive)", () => {
    expect(parseCommand("!review")).toEqual({
      command: null,
      text: "!review",
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

  describe("recognizes all known commands", () => {
    const knownCommands = [
      "build",
      "frontend",
      "architect",
      "reset",
      "status",
      "repo",
      "branch",
      "agent",
      "provider",
      "quiet",
      "verbose",
      "normal",
      "help",
      "adhoc",
      "bugs",
      "mute",
      "unmute",
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
