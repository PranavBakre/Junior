import { describe, expect, test } from "bun:test";
import {
  evaluateBusyFollowup,
  type BusyFollowupContext,
  type FollowupMessageContext,
} from "./followup-policy.ts";

const message: FollowupMessageContext = {
  text: "one short conversational message",
  hasFiles: false,
  hasCommand: false,
  hasPipelineMetadata: false,
  isInternal: false,
};

function baseContext(overrides: Partial<BusyFollowupContext> = {}): BusyFollowupContext {
  return {
    enabled: true,
    senderUserId: "U_HUMAN",
    activeTurnAuthor: "U_HUMAN",
    activeMessage: message,
    incomingMessage: { ...message, text: "small correction" },
    maxMessageLength: 240,
    maxWordCount: 40,
    elapsedMs: 10_000,
    maxElapsedMs: 20_000,
    activeTurnHasSideEffects: false,
    activeTurnAlreadyInterrupted: false,
    sameAgentSlot: true,
    ownsExactHandle: true,
    providerSupportsInterruption: true,
    ...overrides,
  };
}

describe("evaluateBusyFollowup", () => {
  test("interrupts an eligible short same-author follow-up", () => {
    expect(evaluateBusyFollowup(baseContext())).toEqual({
      action: "interrupt",
      reason: "eligible-short-followup",
    });
  });

  test.each([
    [{ enabled: false }, "feature-disabled"],
    [{ senderUserId: null }, "sender-is-not-human"],
    [{ activeTurnAuthor: null }, "no-active-turn-author"],
    [{ senderUserId: "U_OTHER" }, "different-author"],
    [{ sameAgentSlot: false }, "different-agent-slot"],
    [{ ownsExactHandle: false }, "handle-not-owned"],
    [{ providerSupportsInterruption: false }, "provider-not-supported"],
    [{ activeMessage: null }, "no-active-message"],
    [{ elapsedMs: 20_001 }, "outside-time-window"],
    [{ activeTurnHasSideEffects: true }, "side-effects-started"],
    [{ activeTurnAlreadyInterrupted: true }, "already-interrupted"],
  ] as const)("buffers unsafe context %#", (overrides, reason) => {
    expect(evaluateBusyFollowup(baseContext(overrides))).toEqual({
      action: "buffer",
      reason,
    });
  });

  test.each([
    [{ hasFiles: true }, "incoming-has-files"],
    [{ hasCommand: true }, "incoming-has-command"],
    [{ hasPipelineMetadata: true }, "incoming-has-pipeline-metadata"],
    [{ isInternal: true }, "incoming-is-internal"],
    [{ text: "x".repeat(241) }, "incoming-too-long"],
    [{ text: Array.from({ length: 41 }, () => "word").join(" ") }, "incoming-too-many-words"],
    [{ text: "first line\nsecond line" }, "incoming-multiline-or-code"],
  ] as const)("buffers unsafe incoming message %#", (incoming, reason) => {
    expect(
      evaluateBusyFollowup(
        baseContext({ incomingMessage: { ...message, ...incoming } }),
      ),
    ).toEqual({ action: "buffer", reason });
  });

  test("applies the same safety checks to the original active message", () => {
    expect(
      evaluateBusyFollowup(
        baseContext({ activeMessage: { ...message, hasFiles: true } }),
      ),
    ).toEqual({ action: "buffer", reason: "active-has-files" });
  });

  test("allows exact character, word, and time boundaries", () => {
    const fortyWords = Array.from({ length: 40 }, () => "word").join(" ");
    const exactChars = fortyWords.padEnd(240, "x");
    expect(
      evaluateBusyFollowup(
        baseContext({
          activeMessage: { ...message, text: exactChars },
          incomingMessage: { ...message, text: exactChars },
          elapsedMs: 20_000,
        }),
      ).action,
    ).toBe("interrupt");
  });
});
