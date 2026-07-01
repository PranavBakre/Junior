import { describe, expect, it } from "bun:test";

import {
  buildCodexConsolidationArgs,
  buildOpenCodeConsolidationArgs,
  createRunnerInvoke,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENCODE_MODEL,
  extractOpenCodeAssistantText,
  parseConsolidationOutput,
  sanitizeClaudeModel,
  type RunText,
} from "./runner.ts";
import type { ConsolidationOutput } from "./types.ts";

const WELL_FORMED: ConsolidationOutput = {
  episodes: [{ sourceRecordId: "src-1", emotion: "frustration", intensity: 0.7 }],
  profiles: [{ kind: "person", entity_ref: "pranav:person", body: "principal; pushes back on merge-rule violations." }],
  claims: [{ kind: "lesson", text: "Always go dev-first; never auto-merge to main." }],
};

/** A fake subprocess: returns canned model text without spawning a real claude. */
function fakeRunText(text: string): RunText {
  return async () => text;
}

describe("createRunnerInvoke", () => {
  it("parses well-formed JSON into a ConsolidationOutput", async () => {
    const invoke = createRunnerInvoke({ runText: fakeRunText(JSON.stringify(WELL_FORMED)) });
    const out = await invoke("PROMPT");
    expect(out).toEqual(WELL_FORMED);
  });

  it("parses JSON wrapped in ```json fences", async () => {
    const fenced = "```json\n" + JSON.stringify(WELL_FORMED) + "\n```";
    const invoke = createRunnerInvoke({ runText: fakeRunText(fenced) });
    const out = await invoke("PROMPT");
    expect(out).toEqual(WELL_FORMED);
  });

  it("extracts the object when the model adds surrounding prose", async () => {
    const noisy = `Here is the result:\n${JSON.stringify(WELL_FORMED)}\nLet me know if you need more.`;
    const invoke = createRunnerInvoke({ runText: fakeRunText(noisy) });
    const out = await invoke("PROMPT");
    expect(out).toEqual(WELL_FORMED);
  });

  it("coerces missing arrays to [] (the high-bar empty default)", async () => {
    const invoke = createRunnerInvoke({ runText: fakeRunText('{"claims":[]}') });
    const out = await invoke("PROMPT");
    expect(out).toEqual({ episodes: [], profiles: [], claims: [] });
  });

  it("throws on empty output", async () => {
    const invoke = createRunnerInvoke({ runText: fakeRunText("   ") });
    await expect(invoke("PROMPT")).rejects.toThrow(/no JSON object/);
  });

  it("throws on non-JSON garbage", async () => {
    const invoke = createRunnerInvoke({ runText: fakeRunText("totally not json") });
    await expect(invoke("PROMPT")).rejects.toThrow();
  });

  it("throws when the top-level is not an object", async () => {
    const invoke = createRunnerInvoke({ runText: fakeRunText("[1, 2, 3]") });
    await expect(invoke("PROMPT")).rejects.toThrow();
  });

  it("throws when a derivation field is present but not an array", async () => {
    const invoke = createRunnerInvoke({ runText: fakeRunText('{"episodes":"nope","profiles":[],"claims":[]}') });
    await expect(invoke("PROMPT")).rejects.toThrow(/"episodes" must be an array/);
  });

  it("throws when an array element is not an object", async () => {
    const invoke = createRunnerInvoke({ runText: fakeRunText('{"episodes":["x"],"profiles":[],"claims":[]}') });
    await expect(invoke("PROMPT")).rejects.toThrow(/non-object element/);
  });

  it("appends the JSON-only output contract (schema) to the prompt", async () => {
    let seen = "";
    const invoke = createRunnerInvoke({
      runText: async (req) => {
        seen = req.prompt;
        return JSON.stringify({ episodes: [], profiles: [], claims: [] });
      },
    });
    await invoke("ORIGINAL PROMPT BODY");
    expect(seen).toContain("ORIGINAL PROMPT BODY");
    expect(seen).toContain("OUTPUT CONTRACT");
    expect(seen).toContain('"episodes"'); // schema is inlined
    expect(seen).toContain('{"episodes":[],"profiles":[],"claims":[]}');
  });

  it("forwards the configured timeout and model to the subprocess boundary", async () => {
    let seenTimeout = 0;
    let seenModel: string | undefined;
    const invoke = createRunnerInvoke({
      timeoutMs: 1234,
      model: "claude-opus-4",
      runText: async (req) => {
        seenTimeout = req.timeoutMs;
        seenModel = req.model;
        return JSON.stringify({ episodes: [], profiles: [], claims: [] });
      },
    });
    await invoke("PROMPT");
    expect(seenTimeout).toBe(1234);
    expect(seenModel).toBe("claude-opus-4");
  });

  it("propagates a subprocess timeout error (no real claude spawned)", async () => {
    const invoke = createRunnerInvoke({
      timeoutMs: 50,
      runText: async (req) => {
        throw new Error(`consolidation runner: claude timed out after ${req.timeoutMs}ms`);
      },
    });
    await expect(invoke("PROMPT")).rejects.toThrow(/timed out after 50ms/);
  });

  it("pins the opencode model by default (no runner/model given)", async () => {
    let seenModel: string | undefined;
    const invoke = createRunnerInvoke({
      runText: async (req) => {
        seenModel = req.model;
        return JSON.stringify({ episodes: [], profiles: [], claims: [] });
      },
    });
    await invoke("PROMPT");
    expect(seenModel).toBe(DEFAULT_OPENCODE_MODEL);
  });

  it("pins the claude model when runner=claude and no model is given", async () => {
    let seenModel: string | undefined;
    const invoke = createRunnerInvoke({
      runner: "claude",
      runText: async (req) => {
        seenModel = req.model;
        return JSON.stringify({ episodes: [], profiles: [], claims: [] });
      },
    });
    await invoke("PROMPT");
    expect(seenModel).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it("pins the codex model + low effort when runner=codex and neither is given", async () => {
    let seenModel: string | undefined;
    let seenEffort: string | undefined;
    const invoke = createRunnerInvoke({
      runner: "codex",
      runText: async (req) => {
        seenModel = req.model;
        seenEffort = req.effort;
        return JSON.stringify({ episodes: [], profiles: [], claims: [] });
      },
    });
    await invoke("PROMPT");
    expect(seenModel).toBe(DEFAULT_CODEX_MODEL);
    expect(seenEffort).toBe("low");
  });

  it("forwards an explicit codex effort override", async () => {
    let seenEffort: string | undefined;
    const invoke = createRunnerInvoke({
      runner: "codex",
      effort: "high",
      runText: async (req) => {
        seenEffort = req.effort;
        return JSON.stringify({ episodes: [], profiles: [], claims: [] });
      },
    });
    await invoke("PROMPT");
    expect(seenEffort).toBe("high");
  });
});

describe("opencode consolidation runText helpers", () => {
  it("builds a stripped one-shot argv: run --format json --model <m> <prompt>", () => {
    expect(buildOpenCodeConsolidationArgs("THE PROMPT", "opencode-go/deepseek-v4-pro")).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "opencode-go/deepseek-v4-pro",
      "THE PROMPT",
    ]);
  });

  it("omits --model when none is given (no session/dir/agent/mcp flags either)", () => {
    expect(buildOpenCodeConsolidationArgs("THE PROMPT")).toEqual(["run", "--format", "json", "THE PROMPT"]);
  });

  it("extracts the final assistant text from an opencode NDJSON envelope", () => {
    const payload = '{"episodes":[],"profiles":[],"claims":[]}';
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses-123" }),
      JSON.stringify({ type: "text", text: payload }),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n");

    const text = extractOpenCodeAssistantText(stdout);
    expect(text).toBe(payload);
    // And it round-trips through the consolidation parser.
    expect(parseConsolidationOutput(text)).toEqual({ episodes: [], profiles: [], claims: [] });
  });
});

describe("codex consolidation runText helpers", () => {
  it("builds a fully-isolated one-shot argv reading the prompt from stdin", () => {
    const args = buildCodexConsolidationArgs("gpt-5.5", "low", "/tmp/out-abc.txt");

    // Isolation flags — must all be present so junior's hooks/rules can't hijack output.
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--skip-git-repo-check");

    // Model + reasoning effort are pinned.
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.5");
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe('model_reasoning_effort="low"');

    // Output goes to the given file; the trailing "-" reads the prompt from stdin.
    expect(args).toContain("-o");
    expect(args[args.indexOf("-o") + 1]).toBe("/tmp/out-abc.txt");
    expect(args[args.length - 1]).toBe("-");

    // Read-only sandbox, no positional prompt (it's on stdin, not argv).
    expect(args).toEqual(expect.arrayContaining(["exec", "-s", "read-only", "--color", "never"]));
    expect(args).not.toContain("THE PROMPT");
  });

  it("threads the effort override into the -c flag", () => {
    const args = buildCodexConsolidationArgs("gpt-5.5", "high", "/tmp/out.txt");
    expect(args[args.indexOf("-c") + 1]).toBe('model_reasoning_effort="high"');
  });
});

describe("sanitizeClaudeModel", () => {
  it("strips a trailing [1M]-style bracket tag that is not part of the model id", () => {
    expect(sanitizeClaudeModel("claude-opus-4-6[1M]")).toBe("claude-opus-4-6");
    expect(sanitizeClaudeModel("claude-opus-4-6 [1M]")).toBe("claude-opus-4-6");
  });

  it("leaves a clean model id untouched", () => {
    expect(sanitizeClaudeModel("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(sanitizeClaudeModel(DEFAULT_CLAUDE_MODEL)).toBe("claude-opus-4-6");
  });
});

describe("parseConsolidationOutput", () => {
  it("round-trips a minimal empty payload", () => {
    expect(parseConsolidationOutput('{"episodes":[],"profiles":[],"claims":[]}')).toEqual({
      episodes: [],
      profiles: [],
      claims: [],
    });
  });

  it("throws on an empty string", () => {
    expect(() => parseConsolidationOutput("")).toThrow();
  });
});
