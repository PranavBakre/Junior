import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { buildMongoMcpUrl, buildSlackMcpUrl, parseSlackMcpRunContext } from "./context.ts";

describe("Slack MCP run context", () => {
  it("encodes trusted run context in the MCP URL", () => {
    const session = createSession("thread-1", "C01");
    session.activeAgentName = "default";
    session.humanParticipants = ["U1", "U2"];

    const parsed = new URL(buildSlackMcpUrl(session));

    expect(parsed.searchParams.get("agent")).toBe("default");
    expect(parsed.searchParams.get("channel")).toBe("C01");
    expect(parsed.searchParams.get("thread")).toBe("thread-1");
    expect(parsed.searchParams.get("users")).toBe("U1,U2");
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

  it("parses trusted run context from a request URL", () => {
    expect(
      parseSlackMcpRunContext("/mcp?agent=review&channel=C01&thread=thread-1&users=U1,U2"),
    ).toEqual({
      agent: "review",
      channel: "C01",
      threadId: "thread-1",
      users: ["U1", "U2"],
    });
  });

  it("parses a missing/empty users param as no attributable humans", () => {
    expect(
      parseSlackMcpRunContext("/mcp?agent=review&channel=C01&thread=thread-1")?.users,
    ).toEqual([]);
    expect(
      parseSlackMcpRunContext("/mcp?agent=review&channel=C01&thread=thread-1&users=")?.users,
    ).toEqual([]);
  });

  it("fails closed when context is incomplete", () => {
    expect(parseSlackMcpRunContext("/mcp?agent=review&channel=C01")).toBeNull();
  });
});
