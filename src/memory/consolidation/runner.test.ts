import { describe, expect, it } from "bun:test";

import { createRunnerInvoke, parseConsolidationOutput, type RunText } from "./runner.ts";
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
