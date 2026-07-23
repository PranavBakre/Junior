import { describe, expect, test } from "bun:test";
import { evaluateBusyFollowup, type BusyFollowupContext } from "./followup-policy.ts";

function baseContext(overrides: Partial<BusyFollowupContext> = {}): BusyFollowupContext {
  return {
    enabled: true,
    senderUserId: "U_HUMAN",
    activeTurnAuthor: "U_HUMAN",
    messageLength: 50,
    maxMessageLength: 280,
    activeTurnHasSideEffects: false,
    activeTurnAlreadyInterrupted: false,
    isSenderHuman: true,
    ...overrides,
  };
}

describe("evaluateBusyFollowup", () => {
  test("returns interrupt for eligible short same-author follow-up", () => {
    const result = evaluateBusyFollowup(baseContext());
    expect(result).toEqual({ action: "interrupt", reason: "eligible-short-followup" });
  });

  test("buffers when feature is disabled", () => {
    const result = evaluateBusyFollowup(baseContext({ enabled: false }));
    expect(result.action).toBe("buffer");
    expect(result.reason).toBe("feature-disabled");
  });

  test("buffers when sender is not human", () => {
    const result = evaluateBusyFollowup(baseContext({ isSenderHuman: false }));
    expect(result.action).toBe("buffer");
    expect(result.reason).toBe("sender-is-bot");
  });

  test("buffers when active turn author is unknown", () => {
    const result = evaluateBusyFollowup(baseContext({ activeTurnAuthor: null }));
    expect(result.action).toBe("buffer");
    expect(result.reason).toBe("no-active-turn-author");
  });

  test("buffers when sender differs from active turn author", () => {
    const result = evaluateBusyFollowup(baseContext({ senderUserId: "U_OTHER" }));
    expect(result.action).toBe("buffer");
    expect(result.reason).toBe("different-author");
  });

  test("buffers when message exceeds max length", () => {
    const result = evaluateBusyFollowup(baseContext({ messageLength: 500 }));
    expect(result.action).toBe("buffer");
    expect(result.reason).toBe("message-too-long");
  });

  test("allows messages at exactly max length", () => {
    const result = evaluateBusyFollowup(baseContext({ messageLength: 280, maxMessageLength: 280 }));
    expect(result.action).toBe("interrupt");
  });

  test("buffers when side effects have started", () => {
    const result = evaluateBusyFollowup(baseContext({ activeTurnHasSideEffects: true }));
    expect(result.action).toBe("buffer");
    expect(result.reason).toBe("side-effects-started");
  });

  test("buffers when turn was already interrupted", () => {
    const result = evaluateBusyFollowup(baseContext({ activeTurnAlreadyInterrupted: true }));
    expect(result.action).toBe("buffer");
    expect(result.reason).toBe("already-interrupted");
  });

  test("checks conditions in priority order (disabled wins over other rejections)", () => {
    const result = evaluateBusyFollowup(baseContext({
      enabled: false,
      senderUserId: "U_OTHER",
      messageLength: 500,
      activeTurnHasSideEffects: true,
    }));
    expect(result.reason).toBe("feature-disabled");
  });
});
