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
  it("prefers activeTopLevelMessageTs over postedTs and generation", () => {
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

  it("falls back to postedTs then pending generation then unknown", () => {
    expect(sessionTurnSourceId(
      { threadId: "T1", activeTurnGeneration: "gen-1" },
      "review",
      "posted-ts",
    )).toBe("T1:review:posted-ts");
    expect(sessionTurnSourceId(
      { threadId: "T1", activeTurnGeneration: "gen-1" },
      "review",
    )).toBe("T1:review:pending-gen-1");
    expect(sessionTurnSourceId({ threadId: "T1" }, "review")).toBe(
      "T1:review:unknown",
    );
  });
});
