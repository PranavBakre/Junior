import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AgentRouter } from "./router.ts";
import type { ThreadSession } from "../session/types.ts";
import path from "node:path";
import fs from "node:fs/promises";

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: "T1",
    channel: "C1",
    sessionId: null,
    leadSessionId: null,
    agentSessions: {},
    status: "idle",
    worktreePath: null,
    worktreePaths: null,
    agentType: null,
    targetRepo: null,
    baseRef: null,
    systemPrompt: null,
    pid: null,
    lastError: null,
    pendingMessages: [],
    verbosity: "normal",
    muted: false,
    lastActivity: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  } as ThreadSession;
}

describe("AgentRouter overlay", () => {
  let tmpRoot: string;
  let fallbackDir: string;
  let orgDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp("/tmp/junior-router-test-");
    fallbackDir = path.join(tmpRoot, "public");
    orgDir = path.join(tmpRoot, "org");
    await fs.mkdir(path.join(fallbackDir, "common"), { recursive: true });
    await fs.mkdir(path.join(orgDir, "common"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("falls back to the org overlay when an agent .md isn't in the public dir", async () => {
    await fs.writeFile(
      path.join(orgDir, "gx-debug.md"),
      `---\nname: gx-debug\n---\n\nprivate agent body`,
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    const def = await router.resolveAgent(makeSession({ agentType: "gx-debug" }));

    expect(def).not.toBeNull();
    expect(def!.name).toBe("gx-debug");
    expect(def!.prompt).toBe("private agent body");
  });

  it("overlay takes precedence over public fallback when both define the same agent (no targetRepo)", async () => {
    await fs.writeFile(
      path.join(orgDir, "build.md"),
      `---\nname: build\n---\n\nORG VERSION`,
    );
    await fs.writeFile(
      path.join(fallbackDir, "build.md"),
      `---\nname: build\n---\n\nPUBLIC VERSION`,
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    const def = await router.resolveAgent(makeSession({ agentType: "build" }));

    // Search order is target-repo → org → public. With no targetRepo on the
    // session, the org overlay matches before the public fallback, so org wins.
    expect(def!.prompt).toBe("ORG VERSION");
  });

  it("composeSystemPrompt appends org common to target-repo common (skipping public common)", async () => {
    // Asymmetric load chain: target-repo OR public is exclusive; overlay is
    // additive. Regression guard for the case where a target repo has its own
    // common dir — public common is bypassed but overlay still appends.
    const targetRepoDir = path.join(tmpRoot, "target-repo");
    await fs.mkdir(path.join(targetRepoDir, ".claude/agents/common"), { recursive: true });
    await fs.writeFile(
      path.join(targetRepoDir, ".claude/agents/common/repo-rules.md"),
      "# target-repo common",
    );
    await fs.writeFile(
      path.join(orgDir, "common", "org-rules.md"),
      "# org common",
    );
    await fs.writeFile(
      path.join(fallbackDir, "common", "public-rules.md"),
      "# public common (should NOT appear when target has its own common)",
    );

    const router = new AgentRouter(
      [{ name: "target-repo", path: targetRepoDir, defaultBase: "origin/main" }],
      fallbackDir,
      orgDir,
    );
    const prompt = await router.composeSystemPrompt(
      makeSession({ targetRepo: "target-repo" }),
    );

    expect(prompt).not.toBeNull();
    expect(prompt!).toContain("# target-repo common");
    expect(prompt!).toContain("# org common");
    expect(prompt!).not.toContain("# public common");
    // Order: target-repo common first, then overlay.
    expect(prompt!.indexOf("# target-repo common")).toBeLessThan(
      prompt!.indexOf("# org common"),
    );
  });

  it("composeSystemPrompt appends org common files additively to public common", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "common", "philosophy.md"),
      "# public philosophy",
    );
    await fs.writeFile(
      path.join(orgDir, "common", "merge-workflow.md"),
      "# org merge rules",
    );
    await fs.writeFile(
      path.join(fallbackDir, "lead.md"),
      `---\nname: lead\n---\n\nLEAD BODY`,
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    const prompt = await router.composeSystemPrompt(
      makeSession({ agentType: "lead" }),
    );

    expect(prompt).not.toBeNull();
    expect(prompt!).toContain("# public philosophy");
    expect(prompt!).toContain("# org merge rules");
    expect(prompt!).toContain("LEAD BODY");
    // Org appears AFTER public common (more authoritative trailing block).
    expect(prompt!.indexOf("# public philosophy")).toBeLessThan(
      prompt!.indexOf("# org merge rules"),
    );
  });

  it("returns only common preamble when no agent definition resolves", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "common", "philosophy.md"),
      "# only common",
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    // No agentType → no agent definition; composeSystemPrompt should still
    // emit the common preamble (this is the default-agent path).
    const prompt = await router.composeSystemPrompt(makeSession());

    expect(prompt).toBe("# only common");
  });

  it("no org dir configured → still works, just no overlay", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "build.md"),
      `---\nname: build\n---\n\nPUBLIC ONLY`,
    );

    const router = new AgentRouter([], fallbackDir);
    const def = await router.resolveAgent(makeSession({ agentType: "build" }));

    expect(def!.prompt).toBe("PUBLIC ONLY");
  });
});
