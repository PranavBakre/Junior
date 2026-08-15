import { describe, expect, it } from "bun:test";
import { resolveContinueRoute } from "./continue-route.ts";
import { createSession } from "./types.ts";

function sessionWith(overrides: Parameters<typeof Object.assign>[1] = {}) {
  return Object.assign(createSession("thread-1", "C123"), overrides);
}

describe("resolveContinueRoute", () => {
  it("routes lead to the top-level lead handle", () => {
    expect(resolveContinueRoute("lead", sessionWith())).toEqual({
      kind: "top-level",
      handle: "lead",
    });
  });

  it("routes default to the top-level default handle", () => {
    expect(resolveContinueRoute("default", sessionWith())).toEqual({
      kind: "top-level",
      handle: "default",
    });
  });

  it("aliases junior to the top-level default handle", () => {
    expect(resolveContinueRoute("junior", sessionWith({ defaultAgent: "lead" }))).toEqual({
      kind: "top-level",
      handle: "default",
    });
  });

  it("uses defaultAgent then activeAgentName then default when the request is missing", () => {
    expect(resolveContinueRoute(undefined, sessionWith({ defaultAgent: "lead" }))).toEqual({
      kind: "top-level",
      handle: "lead",
    });
    expect(resolveContinueRoute(undefined, sessionWith({
      defaultAgent: "junior",
      activeAgentName: "review",
    }))).toEqual({
      kind: "top-level",
      handle: "default",
    });
    expect(resolveContinueRoute(undefined, sessionWith({ activeAgentName: "lead" }))).toEqual({
      kind: "top-level",
      handle: "lead",
    });
    expect(resolveContinueRoute(undefined, sessionWith())).toEqual({
      kind: "top-level",
      handle: "default",
    });
  });

  it("allows an existing worker agentSessions row", () => {
    expect(resolveContinueRoute("review", sessionWith({
      agentSessions: {
        review: {
          agentName: "review",
          sessionId: "ses-review",
          status: "idle",
          lastActivity: Date.now(),
          pendingMessages: [],
        },
      },
    }))).toEqual({
      kind: "worker",
      agentName: "review",
    });
  });

  it("rejects unknown or not-on-thread workers", () => {
    expect(resolveContinueRoute("review", sessionWith())).toEqual({
      error: "unknown-agent",
    });
    expect(resolveContinueRoute("pm", sessionWith({
      agentSessions: {
        review: {
          agentName: "review",
          sessionId: "ses-review",
          status: "idle",
          lastActivity: Date.now(),
          pendingMessages: [],
        },
      },
    }))).toEqual({
      error: "unknown-agent",
    });
  });
});
