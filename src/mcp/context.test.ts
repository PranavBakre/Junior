import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { buildSlackMcpUrl, parseSlackMcpRunContext } from "./context.ts";

describe("Slack MCP run context", () => {
  it("encodes trusted run context in the MCP URL", () => {
    const session = createSession("thread-1", "C01");
    session.activeAgentName = "default";

    const parsed = new URL(buildSlackMcpUrl(session));

    expect(parsed.searchParams.get("agent")).toBe("default");
    expect(parsed.searchParams.get("channel")).toBe("C01");
    expect(parsed.searchParams.get("thread")).toBe("thread-1");
  });

  it("parses trusted run context from a request URL", () => {
    expect(parseSlackMcpRunContext("/mcp?agent=review&channel=C01&thread=thread-1")).toEqual({
      agent: "review",
      channel: "C01",
      threadId: "thread-1",
    });
  });

  it("fails closed when context is incomplete", () => {
    expect(parseSlackMcpRunContext("/mcp?agent=review&channel=C01")).toBeNull();
  });
});
