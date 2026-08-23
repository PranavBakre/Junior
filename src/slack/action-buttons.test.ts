import { describe, expect, it } from "bun:test";
import { resolveDispatchAgent, shouldBypassDefaultRun } from "./action-buttons.ts";

describe("resolveDispatchAgent", () => {
  it("routes review make-fix to default outside support channels", () => {
    expect(
      resolveDispatchAgent(
        {
          channelId: "C-JUNIOR",
          action: {
            id: "review:make-fix",
            label: "Make fix",
            type: "dispatch_agent",
            agent: "thinker",
            prompt: "fix it",
          },
        },
        new Set(["C-BUGS"]),
      ),
    ).toBe("default");
  });

  it("routes review make-fix to Junior in support channels", () => {
    expect(
      resolveDispatchAgent(
        {
          channelId: "C-BUGS",
          action: {
            id: "review:make-fix",
            label: "Make fix",
            type: "dispatch_agent",
            agent: "default",
            prompt: "fix it",
          },
        },
        new Set(["C-BUGS"]),
      ),
    ).toBe("default");
  });

  it("routes review merge actions with the retired lead identity to default", () => {
    expect(
      resolveDispatchAgent(
        {
          channelId: "C-JUNIOR",
          action: {
            id: "review:merge-gxt-admin",
            label: "Merge via gxt-admin",
            type: "dispatch_agent",
            agent: "lead",
            prompt: "merge the review-approved PR",
          },
        },
        new Set(["C-BUGS"]),
      ),
    ).toBe("default");
  });

  it("leaves other dispatch actions unchanged", () => {
    expect(
      resolveDispatchAgent(
        {
          channelId: "C-JUNIOR",
          action: {
            id: "review:rereview",
            label: "Re-review",
            type: "dispatch_agent",
            agent: "review",
            prompt: "review again",
          },
        },
        new Set(["C-BUGS"]),
      ),
    ).toBe("review");
  });
});

describe("shouldBypassDefaultRun", () => {
  it("keeps Re-review from creating a second default run", () => {
    expect(
      shouldBypassDefaultRun({
        id: "review:rereview",
        label: "Re-review",
        type: "dispatch_agent",
        agent: "review",
        prompt: "review again",
      }),
    ).toBe(true);
  });

  it("keeps Make fix on the durable default-run path", () => {
    expect(
      shouldBypassDefaultRun({
        id: "review:make-fix",
        label: "Make fix",
        type: "dispatch_agent",
        agent: "default",
        prompt: "fix it",
      }),
    ).toBe(false);
  });
});
