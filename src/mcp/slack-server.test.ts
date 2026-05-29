import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { resolveMcpCallerAgent, searchAgentDefinitions } from "./slack-server.ts";

describe("MCP agent search", () => {
  it("finds public agent definitions", async () => {
    const agents = await searchAgentDefinitions({
      query: "default",
      includePublic: true,
      includePrivate: false,
      limit: 10,
    });

    expect(agents.some((agent) => agent.name === "default")).toBe(true);
    expect(agents.every((agent) => agent.origin === "public")).toBe(true);
  });

  it("finds private overlay agent definitions", async () => {
    const agents = await searchAgentDefinitions({
      query: "db-executioner",
      includePublic: false,
      includePrivate: true,
      limit: 10,
    });

    expect(agents).toContainEqual(
      expect.objectContaining({
        name: "db-executioner",
        origin: "private",
        path: "agents-org/db-executioner.md",
      }),
    );
  });
});

describe("MCP agent dispatch caller resolution", () => {
  it("authenticates the busy top-level caller from session state", () => {
    const session = createSession("thread-1", "C123", "normal", "claude", "headless");
    session.status = "busy";
    session.activeAgentName = "default";

    expect(resolveMcpCallerAgent(session)).toEqual({ ok: true, agent: "default" });
  });

  it("authenticates the busy persistent-agent caller from session state", () => {
    const session = createSession("thread-1", "C123", "normal", "claude", "headless");
    session.agentSessions.review = {
      agentName: "review",
      sessionId: null,
      status: "busy",
      pendingMessages: [],
      lastActivity: Date.now(),
      pid: null,
    };

    expect(resolveMcpCallerAgent(session)).toEqual({ ok: true, agent: "review" });
  });

  it("fails closed when caller identity is ambiguous", () => {
    const session = createSession("thread-1", "C123", "normal", "claude", "headless");
    session.status = "busy";
    session.activeAgentName = "default";
    session.agentSessions.review = {
      agentName: "review",
      sessionId: null,
      status: "busy",
      pendingMessages: [],
      lastActivity: Date.now(),
      pid: null,
    };

    expect(resolveMcpCallerAgent(session)).toMatchObject({ ok: false });
  });
});
