import { describe, expect, it } from "bun:test";
import { resolveDispatchAgent } from "./action-buttons.ts";

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

  it("routes review make-fix to thinker in support channels", () => {
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
    ).toBe("thinker");
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
