import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPreRecallClaudeArgs,
  buildSynthesisPrompt,
  createPreRecall,
  deriveRecallQueries,
  parseSynthesisResult,
  selectSynthesisCandidates,
  type RunTextFn,
  type SynthesisCandidate,
} from "./pre-recall.ts";
import type { Config } from "../config.ts";
import { addMemory, type MemoryToolDeps } from "../mcp/slack-server.ts";
import { createMemoryStore } from "./factory.ts";
import { HashingEmbeddingProvider } from "./embedding/hashing.ts";
import { createProfileStore } from "./profiles/index.ts";

describe("buildPreRecallClaudeArgs", () => {
  const args = buildPreRecallClaudeArgs("claude-haiku-4-5-20251001");

  test("locks the subprocess down for untrusted Slack input", () => {
    // No tools, no ambient MCP servers, no user/project hooks — the same
    // lockdown contract as the other untrusted-content claude -p runners.
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    const settingsIdx = args.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(JSON.parse(args[settingsIdx + 1]!)).toEqual({ disableAllHooks: true });
  });

  test("keeps the message off argv (stdin-only prompt)", () => {
    // Bare -p with no inline prompt: the caller writes the message to stdin.
    expect(args[0]).toBe("-p");
    expect(args[1]).toMatch(/^--/);
  });
});

describe("deriveRecallQueries", () => {
  test("uses the raw message as the query, with no subprocess", () => {
    expect(deriveRecallQueries("shift simran's ticket to delhi")).toEqual([
      "shift simran's ticket to delhi",
    ]);
  });

  test("adds one repo/agent-scoped variant when the session has scope", () => {
    expect(
      deriveRecallQueries("review the PR", { repo: "gx-backend", agent: "review" }),
    ).toEqual(["review the PR", "gx-backend review: review the PR"]);
  });

  test("collapses whitespace and drops empty messages", () => {
    expect(deriveRecallQueries("  hey\n\n  there ")).toEqual(["hey there"]);
    expect(deriveRecallQueries("   ")).toEqual([]);
  });
});

describe("selectSynthesisCandidates", () => {
  function makeCandidates(
    count: number,
    textLength: number,
  ): SynthesisCandidate[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `claim-${index}`,
      // Descending score so index order is also rank order.
      score: 1 - index / 100,
      text: "x".repeat(textLength),
    }));
  }

  test("truncates each claim so one long claim cannot blow the prompt", () => {
    const [only] = selectSynthesisCandidates([
      { id: "long", score: 1, text: "y".repeat(10_000) },
    ]);
    expect(only!.text.length).toBeLessThanOrEqual(600);
    expect(only!.text.endsWith("…")).toBe(true);
  });

  test("caps the candidate count, keeping the highest scores", () => {
    const kept = selectSynthesisCandidates(makeCandidates(30, 10));
    expect(kept).toHaveLength(12);
    expect(kept.map((c) => c.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `claim-${i}`),
    );
  });

  test("drops the lowest-scoring candidates at the character ceiling", () => {
    // 12 max-length claims would be 7200 chars; the 6000 ceiling admits 10.
    const kept = selectSynthesisCandidates(makeCandidates(12, 600));
    expect(kept).toHaveLength(10);
    expect(kept.at(-1)!.id).toBe("claim-9");
  });

  test("keeps the top candidate even when it alone fills the budget", () => {
    const kept = selectSynthesisCandidates([
      { id: "huge", score: 1, text: "z".repeat(50_000) },
      { id: "small", score: 0.1, text: "small" },
    ]);
    expect(kept.map((c) => c.id)).toEqual(["huge", "small"]);
  });

  test("ranks by score, not input order", () => {
    const kept = selectSynthesisCandidates([
      { id: "low", score: 0.1, text: "a" },
      { id: "high", score: 0.9, text: "b" },
    ]);
    expect(kept.map((c) => c.id)).toEqual(["high", "low"]);
  });
});

describe("buildSynthesisPrompt", () => {
  test("numbers the candidates and bounds the request text", () => {
    const prompt = buildSynthesisPrompt("x".repeat(5_000), [
      { id: "a", score: 1, text: "first claim" },
      { id: "b", score: 0.5, text: "second claim" },
    ]);
    expect(prompt).toContain("[1] first claim");
    expect(prompt).toContain("[2] second claim");
    expect(prompt.length).toBeLessThan(2_000);
  });
});

describe("parseSynthesisResult", () => {
  test("reads notes and 1-based used indexes", () => {
    expect(parseSynthesisResult('{"notes":["merged line"],"used":[1,3]}', 3)).toEqual({
      notes: ["merged line"],
      usedIndexes: [1, 3],
    });
  });

  test("tolerates code fences and surrounding prose", () => {
    expect(
      parseSynthesisResult('```json\n{"notes":["a"],"used":[2]}\n```', 2),
    ).toEqual({ notes: ["a"], usedIndexes: [2] });
    expect(
      parseSynthesisResult('Here you go: {"notes":["a"],"used":[]} — done', 2),
    ).toEqual({ notes: ["a"], usedIndexes: [] });
  });

  test("drops indexes outside the shortlist and duplicates", () => {
    expect(
      parseSynthesisResult('{"notes":["a"],"used":[0,1,1,9,2.5]}', 2),
    ).toEqual({ notes: ["a"], usedIndexes: [1] });
  });

  test("caps the emitted notes", () => {
    const parsed = parseSynthesisResult(
      JSON.stringify({ notes: ["a", "b", "c", "d", "e", "f", "g"], used: [] }),
      1,
    );
    expect(parsed!.notes).toHaveLength(5);
  });

  test("returns null on unparseable output so the caller can fall back", () => {
    expect(parseSynthesisResult("I could not do that", 3)).toBeNull();
    expect(parseSynthesisResult("[1, 2, 3]", 3)).toBeNull();
  });
});

// ── Closure: retrieval, synthesis, usage recording ───────────────────────────
//
// Backed by REAL infrastructure (in-memory SQLite claim store, the
// deterministic hashing embedding provider, a temp-dir profile store). Only the
// synthesis subprocess is replaced — that is the system boundary (CLAUDE.md
// rule 15).

function makeMemoryDeps(): { deps: MemoryToolDeps; cleanup: () => void } {
  const store = createMemoryStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "junior-pre-recall-"));
  return {
    deps: {
      store,
      provider: new HashingEmbeddingProvider(),
      profileStore: createProfileStore({ root }),
    },
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function preRecallConfig(): Config {
  return {
    slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "" },
    claude: {
      maxTurns: 25,
      timeoutMs: 300000,
      permissionMode: "bypassPermissions",
      defaultModel: null,
      defaultDriver: "headless",
      tmuxIdleTtlMs: 14400000,
      tmuxSweepIntervalMs: 900000,
    },
    runner: { provider: "claude" },
    opencode: {
      model: null,
      timeoutMs: 300000,
      continuityEnabled: false,
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
    },
    codex: {
      mode: "app-server",
      model: null,
      timeoutMs: 300000,
      sandbox: "workspace-write",
      askForApproval: "never",
      searchEnabled: false,
      appServerContinuityEnabled: false,
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
      memoryMcpEnabled: true,
      isolatedHomePath: "data/codex-home",
    },
    repos: [],
    session: {
      staleTimeoutMs: 86400000,
      cleanupIntervalMs: 900000,
      store: "memory",
      sqlitePath: "data/sessions.db",
      homeWindowMs: 172800000,
      defaultVerbosity: "normal",
      idleTimeoutMs: 300000,
      maxIdleInterrupts: 3,
      shortFollowupInterruptEnabled: false,
      shortFollowupMaxLength: 280,
    },
    memory: {
      sqlitePath: ":memory:",
      embedProvider: "hashing",
      preRecall: {
        enabled: true,
        runner: "claude",
        timeoutMs: 15000,
      },
    },
    threadArchives: { dir: "data/thread-archives" },
    channelDefaults: {},
    adminSlackUserId: null,
    http: { enabled: false, port: 0 },
  };
}

const CLAIM_TEXTS = [
  "Create worktrees from origin/main, never the local checkout",
  "Resolve merge conflicts in the target branch, not the feature branch",
  "All GrowthX repos use npm, not pnpm or bun",
  "Merge to main with the gxt-admin token, never the personal account",
];

async function seedClaims(deps: MemoryToolDeps): Promise<void> {
  for (const text of CLAIM_TEXTS) {
    await addMemory({ text }, deps);
  }
}

/** Claim ids whose `last_used_at` has been bumped. */
async function usedClaimTexts(deps: MemoryToolDeps): Promise<string[]> {
  const claims = await deps.store.recallClaims({ limit: 50, recordUsage: false });
  return claims.filter((c) => c.lastUsedAt != null).map((c) => c.text).sort();
}

/** The candidate texts the synthesis prompt actually offered, in rank order. */
function shortlistFromPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/^\[\d+\] (.+)$/gm)].map((match) => match[1]!);
}

describe("createPreRecall", () => {
  test("records usage only for the claims synthesis used", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      await seedClaims(deps);
      let shortlist: string[] = [];
      const runText: RunTextFn = async (req) => {
        shortlist = shortlistFromPrompt(req.prompt);
        return '{"notes":["merged operational note"],"used":[1]}';
      };

      const preRecall = createPreRecall(preRecallConfig(), { runText, deps });
      const block = await preRecall("how do I create a worktree");

      expect(block).toContain("<pre-recall>");
      expect(block).toContain("- merged operational note");
      // Retrieval saw every seeded claim but must not have marked any used;
      // only the one synthesis credited gets a fresh last_used_at.
      expect(shortlist).toHaveLength(CLAIM_TEXTS.length);
      expect(await usedClaimTexts(deps)).toEqual([shortlist[0]!]);
    } finally {
      cleanup();
    }
  });

  test("emits the top-K raw claims when synthesis times out", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      await seedClaims(deps);
      let shortlist: string[] = [];
      const runText: RunTextFn = async (req) => {
        shortlist = shortlistFromPrompt(req.prompt);
        throw new Error("pre-recall: claude timed out after 15000ms");
      };

      const preRecall = createPreRecall(preRecallConfig(), { runText, deps });
      const block = await preRecall("how do I create a worktree");

      // Never null when candidates exist — that is the whole point of moving
      // the model call to the bounded end of the pipeline.
      expect(block).not.toBeNull();
      const topK = shortlist.slice(0, 3);
      for (const text of topK) expect(block).toContain(`- ${text}`);
      expect(block).not.toContain(`- ${shortlist[3]!}`);
      // Only the emitted claims are marked used, not the whole candidate set.
      expect(await usedClaimTexts(deps)).toEqual([...topK].sort());
    } finally {
      cleanup();
    }
  });

  test("returns null and marks nothing when synthesis rejects every candidate", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      await seedClaims(deps);
      const runText: RunTextFn = async () => '{"notes":[],"used":[]}';

      const preRecall = createPreRecall(preRecallConfig(), { runText, deps });
      expect(await preRecall("hey what's up")).toBeNull();
      expect(await usedClaimTexts(deps)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("returns null without spawning synthesis when nothing is recalled", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      let calls = 0;
      const runText: RunTextFn = async () => {
        calls++;
        return '{"notes":["should not happen"],"used":[]}';
      };

      const preRecall = createPreRecall(preRecallConfig(), { runText, deps });
      expect(await preRecall("anything at all")).toBeNull();
      expect(calls).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("is a no-op when pre-recall is disabled", async () => {
    const config = preRecallConfig();
    config.memory.preRecall!.enabled = false;
    const preRecall = createPreRecall(config, {
      runText: async () => {
        throw new Error("must not run");
      },
    });
    expect(await preRecall("anything")).toBeNull();
  });
});
