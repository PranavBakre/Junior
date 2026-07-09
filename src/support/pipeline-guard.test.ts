import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadSession } from "../session/types.ts";
import { validateLeadPipelineResponse } from "./pipeline-guard.ts";

const CHANNEL = "C_SUPPORT";
const THREAD = "1234.5678";
const supportChannels = new Set([CHANNEL]);

function makeSession(): ThreadSession {
  return {
    threadId: THREAD,
    channel: CHANNEL,
    activeAgentName: "lead",
  } as unknown as ThreadSession;
}

describe("validateLeadPipelineResponse", () => {
  let bugRoot: string;

  beforeEach(() => {
    bugRoot = mkdtempSync(join(tmpdir(), "pipeline-guard-"));
    process.env.JUNIOR_BUG_ROOT = bugRoot;
    const bugDir = join(bugRoot, "gx-client-next", "bug-42");
    mkdirSync(bugDir, { recursive: true });
    writeFileSync(
      join(bugDir, "state.json"),
      JSON.stringify({
        bugId: "bug-42",
        product: "gx-client-next",
        status: "observability_done",
        slackChannel: CHANNEL,
        slackThread: THREAD,
      }),
    );
  });

  afterEach(() => {
    delete process.env.JUNIOR_BUG_ROOT;
    rmSync(bugRoot, { recursive: true, force: true });
  });

  it("allows a Phase-1 Message 1 (hypothesis gate) as a valid advance", () => {
    const message1 = [
      "tldr: stale project_id linking drops personal POWs from the list.",
      "1. Hypothesis A — verify: read listPows filter. refuted",
      "2. Hypothesis B — verify: mongo query on pow.project_id. confirmed",
      "Going with #2: matches the affected user's data shape.",
      "by junior",
    ].join("\n");

    const result = validateLeadPipelineResponse(
      makeSession(),
      message1,
      supportChannels,
      0,
    );
    expect(result.action).toBe("allow");
  });

  it("allows a !reproducer dispatch as a valid advance", () => {
    const result = validateLeadPipelineResponse(
      makeSession(),
      "!reproducer reproduce: personal POW list empty for user X",
      supportChannels,
      0,
    );
    expect(result.action).toBe("allow");
  });

  it("re-prompts when the turn neither advances nor gates", () => {
    const result = validateLeadPipelineResponse(
      makeSession(),
      "DONE: New Relic findings written to research.md",
      supportChannels,
      0,
    );
    expect(result.action).toBe("continue");
  });

  it("escalates to a blocker after a failed retry", () => {
    const result = validateLeadPipelineResponse(
      makeSession(),
      "DONE: New Relic findings written to research.md",
      supportChannels,
      1,
    );
    expect(result.action).toBe("blocker");
  });
});
