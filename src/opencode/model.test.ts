import { describe, expect, it } from "bun:test";
import { resolveOpenCodeModel } from "./model.ts";

describe("resolveOpenCodeModel", () => {
  it("passes through a valid provider/model session reference", () => {
    expect(resolveOpenCodeModel("anthropic/claude-sonnet-4-5", null)).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(
      resolveOpenCodeModel("openai/gpt-5.6-sol", "anthropic/claude-opus-4"),
    ).toBe("openai/gpt-5.6-sol");
  });

  it("ignores runner-specific aliases and falls back to a valid config default", () => {
    // gpt-5.6-sol / opus / haiku / sonnet are Claude/Codex aliases, not OpenCode
    // provider/model refs — slashless strings crash opencode's server.
    expect(resolveOpenCodeModel("gpt-5.6-sol", "anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(resolveOpenCodeModel("opus", "anthropic/claude-opus-4")).toBe(
      "anthropic/claude-opus-4",
    );
    expect(resolveOpenCodeModel("sonnet", "openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(resolveOpenCodeModel("haiku", "anthropic/claude-haiku")).toBe(
      "anthropic/claude-haiku",
    );
  });

  it("returns null when the alias has no valid config default to fall back to", () => {
    // null → omit --model so opencode uses its own configured default.
    expect(resolveOpenCodeModel("gpt-5.6-sol", null)).toBeNull();
    expect(resolveOpenCodeModel("gpt-5.6-sol", undefined)).toBeNull();
    // Config default that is itself an invalid (slashless) ref is not usable.
    expect(resolveOpenCodeModel("gpt-5.6-sol", "gpt-5.6-sol")).toBeNull();
    expect(resolveOpenCodeModel("opus", "opus")).toBeNull();
  });

  it("returns null for null/undefined inputs with no valid default", () => {
    expect(resolveOpenCodeModel(null, null)).toBeNull();
    expect(resolveOpenCodeModel(undefined, undefined)).toBeNull();
    expect(resolveOpenCodeModel(null, undefined)).toBeNull();
  });

  it("uses the config default when session model is null", () => {
    expect(resolveOpenCodeModel(null, "anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(resolveOpenCodeModel(undefined, "openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
  });
});
