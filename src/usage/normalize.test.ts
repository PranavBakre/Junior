import { describe, expect, it } from "bun:test";
import { normalizeRunnerUsage, type UsageMeta } from "./normalize.ts";
import { sessionTurnSourceId } from "./source-id.ts";

const meta: UsageMeta = {
  sourceKind: "session-turn",
  sourceId: "thread-1:default:111.222",
  threadId: "thread-1",
  channelId: "C123",
  agentName: "default",
  provider: "claude",
  providerSessionId: "ses-1",
  pipelineRunId: null,
  assignmentId: null,
  workflowName: null,
  workflowRunId: null,
  occurredAt: 1_700_000_000_000,
};

describe("normalizeRunnerUsage", () => {
  it("maps Claude done usage including cache tokens and provider cost", () => {
    const usage = normalizeRunnerUsage(
      {
        total_cost_usd: 0.042,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        num_turns: 3,
      },
      { ...meta, provider: "claude" },
    );

    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 165,
      costUsd: 0.042,
      costEstimatedUsd: null,
      numTurns: 3,
    });
    expect(usage.raw.total_cost_usd).toBe(0.042);
  });

  it("maps Codex app-server input/output tokens without inventing cost", () => {
    const usage = normalizeRunnerUsage(
      { input_tokens: 12, output_tokens: 8 },
      { ...meta, provider: "codex-app-server" },
    );

    expect(usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 20,
      costUsd: null,
      costEstimatedUsd: null,
      numTurns: null,
    });
  });

  it("preserves Codex app-server cache fields and provider total", () => {
    const usage = normalizeRunnerUsage(
      {
        input_tokens: 10,
        output_tokens: 13,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
        total_tokens: 30,
      },
      { ...meta, provider: "codex-app-server" },
    );

    expect(usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 13,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 30,
    });
  });

  it("maps OpenCode { input, output } tokens", () => {
    const usage = normalizeRunnerUsage(
      { input: 2, output: 3 },
      { ...meta, provider: "opencode" },
    );

    expect(usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      costUsd: null,
      costEstimatedUsd: null,
    });
  });

  it("maps OpenCode input_tokens/output_tokens aliases", () => {
    const usage = normalizeRunnerUsage(
      { input_tokens: 9, output_tokens: 4 },
      { ...meta, provider: "opencode" },
    );

    expect(usage).toMatchObject({
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
    });
  });

  it("maps OpenCode SDK { input, output }", () => {
    const usage = normalizeRunnerUsage(
      { input: 40, output: 6 },
      { ...meta, provider: "opencode-sdk" },
    );

    expect(usage).toMatchObject({
      inputTokens: 40,
      outputTokens: 6,
      totalTokens: 46,
      costUsd: null,
      costEstimatedUsd: null,
    });
  });

  it("inserts a missing-usage row with null tokens and empty raw", () => {
    const usage = normalizeRunnerUsage(undefined, {
      ...meta,
      provider: "opencode",
    });

    expect(usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      costUsd: null,
      costEstimatedUsd: null,
      numTurns: null,
      raw: {},
    });
  });
});

describe("sessionTurnSourceId", () => {
  it("prefers activeTopLevelMessageTs over postedTs and generation for top-level agents", () => {
    expect(sessionTurnSourceId(
      {
        threadId: "T1",
        activeTopLevelMessageTs: "111.1",
        activeTurnGeneration: "gen-1",
      },
      "default",
      "posted-ts",
    )).toBe("T1:default:111.1");
  });

  it("uses invocation ts for workers instead of a stale top-level ts or generation", () => {
    expect(sessionTurnSourceId(
      {
        threadId: "T1",
        activeTopLevelMessageTs: "lead-ts",
        activeTurnGeneration: "gen-1",
      },
      "review",
      "review-ts",
    )).toBe("T1:review:review-ts");
    expect(sessionTurnSourceId(
      {
        threadId: "T1",
        activeTopLevelMessageTs: "lead-ts",
        currentMessageTs: "current-ts",
      },
      "review",
    )).toBe("T1:review:current-ts");
    expect(sessionTurnSourceId(
      { threadId: "T1", activeTurnGeneration: "gen-1" },
      "review",
    )).toBe("T1:review:unknown");
    expect(sessionTurnSourceId({ threadId: "T1" }, "review")).toBe(
      "T1:review:unknown",
    );
  });

  it("falls back to postedTs then pending generation then unknown for top-level", () => {
    expect(sessionTurnSourceId(
      { threadId: "T1", activeTurnGeneration: "gen-1" },
      "default",
      "posted-ts",
    )).toBe("T1:default:posted-ts");
    expect(sessionTurnSourceId(
      { threadId: "T1", activeTurnGeneration: "gen-1" },
      "lead",
    )).toBe("T1:lead:pending-gen-1");
    expect(sessionTurnSourceId({ threadId: "T1" }, "default")).toBe(
      "T1:default:unknown",
    );
  });
});
