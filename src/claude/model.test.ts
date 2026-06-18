import { describe, it, expect } from "bun:test";
import { resolveClaudeModel } from "./model.ts";

describe("resolveClaudeModel", () => {
  const cfg = "claude-sonnet-4-5"; // stand-in configDefaultModel

  describe("precedence 1 — modelClaude override wins", () => {
    it("returns modelClaude when set, regardless of sessionModel", () => {
      expect(
        resolveClaudeModel({
          modelClaude: "opus",
          sessionModel: "gpt-5.5",
          configDefaultModel: cfg,
        }),
      ).toBe("opus");
    });

    it("returns modelClaude when sessionModel is null", () => {
      expect(
        resolveClaudeModel({
          modelClaude: "sonnet",
          sessionModel: null,
          configDefaultModel: cfg,
        }),
      ).toBe("sonnet");
    });

    it("ignores null modelClaude (falls through to next rule)", () => {
      expect(
        resolveClaudeModel({
          modelClaude: null,
          sessionModel: "sonnet",
          configDefaultModel: cfg,
        }),
      ).toBe("sonnet");
    });
  });

  describe("precedence 2 — Claude alias passthrough", () => {
    it("passes 'opus' through verbatim", () => {
      expect(
        resolveClaudeModel({ sessionModel: "opus", configDefaultModel: cfg }),
      ).toBe("opus");
    });

    it("passes 'sonnet' through verbatim", () => {
      expect(
        resolveClaudeModel({ sessionModel: "sonnet", configDefaultModel: cfg }),
      ).toBe("sonnet");
    });

    it("passes 'haiku' through verbatim", () => {
      expect(
        resolveClaudeModel({ sessionModel: "haiku", configDefaultModel: cfg }),
      ).toBe("haiku");
    });

    it("passes 'fable' through verbatim", () => {
      expect(
        resolveClaudeModel({ sessionModel: "fable", configDefaultModel: cfg }),
      ).toBe("fable");
    });

    it("passes full claude- prefixed id through verbatim", () => {
      expect(
        resolveClaudeModel({
          sessionModel: "claude-opus-4-8",
          configDefaultModel: cfg,
        }),
      ).toBe("claude-opus-4-8");
    });

    it("passes claude/ prefixed id through verbatim", () => {
      expect(
        resolveClaudeModel({
          sessionModel: "claude/opus",
          configDefaultModel: cfg,
        }),
      ).toBe("claude/opus");
    });
  });

  describe("precedence 3 — GPT model mapping", () => {
    it("maps gpt-5.5 → opus", () => {
      expect(
        resolveClaudeModel({ sessionModel: "gpt-5.5", configDefaultModel: cfg }),
      ).toBe("opus");
    });

    it("is case-insensitive for the gpt-5.5 → opus mapping", () => {
      expect(
        resolveClaudeModel({ sessionModel: "GPT-5.5", configDefaultModel: cfg }),
      ).toBe("opus");
    });

    it("unmapped GPT model (gpt-5.1) falls back to configDefaultModel", () => {
      expect(
        resolveClaudeModel({ sessionModel: "gpt-5.1", configDefaultModel: cfg }),
      ).toBe(cfg);
    });

    it("unmapped GPT model returns null when configDefaultModel is null", () => {
      expect(
        resolveClaudeModel({ sessionModel: "gpt-5.1", configDefaultModel: null }),
      ).toBeNull();
    });

    it("o-series OpenAI model (o3) falls back to configDefaultModel", () => {
      expect(
        resolveClaudeModel({ sessionModel: "o3", configDefaultModel: cfg }),
      ).toBe(cfg);
    });
  });

  describe("precedence 4 — null / unknown sessionModel", () => {
    it("null sessionModel returns configDefaultModel", () => {
      expect(
        resolveClaudeModel({ sessionModel: null, configDefaultModel: cfg }),
      ).toBe(cfg);
    });

    it("null sessionModel returns null when configDefaultModel is null", () => {
      expect(
        resolveClaudeModel({ sessionModel: null, configDefaultModel: null }),
      ).toBeNull();
    });

    it("unknown non-Claude non-GPT string falls back to configDefaultModel", () => {
      expect(
        resolveClaudeModel({
          sessionModel: "some-mystery-model-9000",
          configDefaultModel: cfg,
        }),
      ).toBe(cfg);
    });
  });
});
