import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import {
  buildMongoMcpUrl,
  buildSlackMcpUrl,
  mcpContextSecret,
  parseSlackMcpRunContext,
  signRunContext,
} from "./context.ts";

describe("Slack MCP run context", () => {
  it("encodes trusted run context in the MCP URL", () => {
    const session = createSession("thread-1", "C01");
    session.activeAgentName = "default";

    const parsed = new URL(buildSlackMcpUrl(session));

    expect(parsed.searchParams.get("agent")).toBe("default");
    expect(parsed.searchParams.get("channel")).toBe("C01");
    expect(parsed.searchParams.get("thread")).toBe("thread-1");
  });

  it("encodes trusted run context in the MongoDB MCP proxy URL", () => {
    const session = createSession("thread-1", "C01");
    session.activeAgentName = "default";

    const parsed = new URL(buildMongoMcpUrl(session));

    expect(parsed.pathname).toBe("/mcp/mongodb");
    expect(parsed.searchParams.get("agent")).toBe("default");
    expect(parsed.searchParams.get("channel")).toBe("C01");
    expect(parsed.searchParams.get("thread")).toBe("thread-1");
  });

  it("uses a process-local secret and rejects unsigned context when no stable secret is configured", () => {
    const prevSecret = process.env.MCP_CONTEXT_SECRET;
    const prevToken = process.env.SLACK_BOT_TOKEN;
    delete process.env.MCP_CONTEXT_SECRET;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      expect(mcpContextSecret()).toHaveLength(64);
      expect(
        parseSlackMcpRunContext("/mcp?agent=review&channel=C01&thread=thread-1"),
      ).toBeNull();
    } finally {
      if (prevSecret !== undefined) process.env.MCP_CONTEXT_SECRET = prevSecret;
      if (prevToken !== undefined) process.env.SLACK_BOT_TOKEN = prevToken;
    }
  });

  it("does not use the runner-visible Slack token as the signing secret", () => {
    const prevSecret = process.env.MCP_CONTEXT_SECRET;
    const prevToken = process.env.SLACK_BOT_TOKEN;
    delete process.env.MCP_CONTEXT_SECRET;
    process.env.SLACK_BOT_TOKEN = "runner-visible-token";
    try {
      expect(mcpContextSecret()).not.toBe("runner-visible-token");
    } finally {
      if (prevSecret !== undefined) process.env.MCP_CONTEXT_SECRET = prevSecret;
      else delete process.env.MCP_CONTEXT_SECRET;
      if (prevToken !== undefined) process.env.SLACK_BOT_TOKEN = prevToken;
      else delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it("rejects unsigned context when a secret is configured", () => {
    const prevSecret = process.env.MCP_CONTEXT_SECRET;
    const prevToken = process.env.SLACK_BOT_TOKEN;
    process.env.MCP_CONTEXT_SECRET = "test-secret-for-mcp";
    delete process.env.SLACK_BOT_TOKEN;
    try {
      expect(
        parseSlackMcpRunContext("/mcp?agent=review&channel=C01&thread=thread-1"),
      ).toBeNull();
      // Spoofed agent with no sig.
      expect(
        parseSlackMcpRunContext(
          "/mcp?agent=attacker&channel=C01&thread=thread-1&exp=9999999999999&sig=deadbeef",
        ),
      ).toBeNull();
    } finally {
      if (prevSecret !== undefined) process.env.MCP_CONTEXT_SECRET = prevSecret;
      else delete process.env.MCP_CONTEXT_SECRET;
      if (prevToken !== undefined) process.env.SLACK_BOT_TOKEN = prevToken;
    }
  });

  it("accepts HMAC-signed context and rejects tampering", () => {
    const prevSecret = process.env.MCP_CONTEXT_SECRET;
    const prevToken = process.env.SLACK_BOT_TOKEN;
    process.env.MCP_CONTEXT_SECRET = "test-secret-for-mcp";
    delete process.env.SLACK_BOT_TOKEN;
    try {
      const exp = String(Date.now() + 60_000);
      const sig = signRunContext(
        "test-secret-for-mcp",
        "review",
        "C01",
        "thread-1",
        exp,
      );
      expect(
        parseSlackMcpRunContext(
          `/mcp?agent=review&channel=C01&thread=thread-1&exp=${exp}&sig=${sig}`,
        ),
      ).toEqual({
        agent: "review",
        channel: "C01",
        threadId: "thread-1",
        signed: true,
      });

      // Tampered agent with same sig.
      expect(
        parseSlackMcpRunContext(
          `/mcp?agent=attacker&channel=C01&thread=thread-1&exp=${exp}&sig=${sig}`,
        ),
      ).toBeNull();
    } finally {
      if (prevSecret !== undefined) process.env.MCP_CONTEXT_SECRET = prevSecret;
      else delete process.env.MCP_CONTEXT_SECRET;
      if (prevToken !== undefined) process.env.SLACK_BOT_TOKEN = prevToken;
    }
  });

  it("fails closed when context is incomplete", () => {
    expect(parseSlackMcpRunContext("/mcp?agent=review&channel=C01")).toBeNull();
  });

  it("buildSlackMcpUrl includes sig when secret is set", () => {
    const prevSecret = process.env.MCP_CONTEXT_SECRET;
    process.env.MCP_CONTEXT_SECRET = "test-secret-for-mcp";
    try {
      const session = createSession("thread-1", "C01");
      session.activeAgentName = "review";
      const url = new URL(buildSlackMcpUrl(session));
      expect(url.searchParams.get("sig")).toBeTruthy();
      expect(url.searchParams.get("exp")).toBeTruthy();
      const parsed = parseSlackMcpRunContext(url.pathname + url.search);
      expect(parsed?.signed).toBe(true);
      expect(parsed?.agent).toBe("review");
    } finally {
      if (prevSecret !== undefined) process.env.MCP_CONTEXT_SECRET = prevSecret;
      else delete process.env.MCP_CONTEXT_SECRET;
    }
  });
});
