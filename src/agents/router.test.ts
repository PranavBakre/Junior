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
    await fs.writeFile(path.join(fallbackDir, "common", "core.md"), "# public core");
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

  it("composeSystemPrompt appends org common to target-repo common when selected", async () => {
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
    await fs.writeFile(
      path.join(fallbackDir, "build.md"),
      `---\nname: build\ncommon: repo-rules,org-rules\n---\n\nBUILD BODY`,
    );

    const router = new AgentRouter(
      [{ name: "target-repo", path: targetRepoDir, defaultBase: "origin/main" }],
      fallbackDir,
      orgDir,
    );
    const prompt = await router.composeSystemPrompt(
      makeSession({ targetRepo: "target-repo", agentType: "build" }),
    );

    expect(prompt).not.toBeNull();
    expect(prompt!).toContain("# target-repo common");
    expect(prompt!).toContain("# org common");
    expect(prompt!).not.toContain("# public common");
    expect(prompt!).toContain("BUILD BODY");
    // Order: target-repo common first, then overlay.
    expect(prompt!.indexOf("# target-repo common")).toBeLessThan(
      prompt!.indexOf("# org common"),
    );
  });

  it("falls back to public common per selected file when target repo overrides only part of the profile", async () => {
    const targetRepoDir = path.join(tmpRoot, "target-repo");
    await fs.mkdir(path.join(targetRepoDir, ".claude/agents/common"), { recursive: true });
    await fs.writeFile(
      path.join(targetRepoDir, ".claude/agents/common/core.md"),
      "# target core",
    );
    await fs.writeFile(
      path.join(fallbackDir, "common", "building-philosophy.md"),
      "# public building",
    );
    await fs.writeFile(
      path.join(fallbackDir, "build.md"),
      `---\nname: build\ncommon: core,building-philosophy\n---\n\nBUILD BODY`,
    );

    const router = new AgentRouter(
      [{ name: "target-repo", path: targetRepoDir, defaultBase: "origin/main" }],
      fallbackDir,
      orgDir,
    );
    const prompt = await router.composeSystemPrompt(
      makeSession({ targetRepo: "target-repo", agentType: "build" }),
    );

    expect(prompt).toContain("# target core");
    expect(prompt).toContain("# public building");
    expect(prompt).toContain("BUILD BODY");
    expect(prompt!.indexOf("# target core")).toBeLessThan(
      prompt!.indexOf("# public building"),
    );
  });

  it("skips nonexistent common profile entries while warning about the missing file", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "common", "core.md"),
      "# core common",
    );
    await fs.writeFile(
      path.join(fallbackDir, "build.md"),
      `---\nname: build\ncommon: core,fictional-module\n---\n\nBUILD BODY`,
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const router = new AgentRouter([], fallbackDir, orgDir);
      const prompt = await router.composeSystemPrompt(
        makeSession({ agentType: "build" }),
      );

      expect(prompt).toContain("# core common");
      expect(prompt).toContain("BUILD BODY");
      expect(prompt).not.toContain("fictional-module");
      expect(warnings.some((msg) => msg.includes("fictional-module.md"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
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
      path.join(fallbackDir, "build.md"),
      `---\nname: build\ncommon: philosophy,merge-workflow\n---\n\nBUILD BODY`,
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    const prompt = await router.composeSystemPrompt(
      makeSession({ agentType: "build" }),
    );

    expect(prompt).not.toBeNull();
    expect(prompt!).toContain("# public philosophy");
    expect(prompt!).toContain("# org merge rules");
    expect(prompt!).toContain("BUILD BODY");
    // Org appears AFTER public common (more authoritative trailing block).
    expect(prompt!.indexOf("# public philosophy")).toBeLessThan(
      prompt!.indexOf("# org merge rules"),
    );
  });

  it("returns selected fallback common preamble when no agent definition resolves", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "common", "core.md"),
      "# core common",
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    const prompt = await router.composeSystemPrompt(makeSession());

    expect(prompt).toBe("# core common");
  });

  it("resolves explicit default agent for top-level default runs", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "common", "core.md"),
      "# core common",
    );
    await fs.writeFile(
      path.join(fallbackDir, "default.md"),
      `---\nname: default\ncommon: core\n---\n\nDEFAULT BODY`,
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    const prompt = await router.composeSystemPrompt(
      makeSession({ activeAgentName: "default" }),
    );

    expect(prompt).toContain("# core common");
    expect(prompt).toContain("DEFAULT BODY");
  });

  it("no org dir configured → still works, just no overlay", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "build.md"),
      `---\nname: build\ncommon: public-rules\n---\n\nPUBLIC ONLY`,
    );

    const router = new AgentRouter([], fallbackDir);
    const def = await router.resolveAgent(makeSession({ agentType: "build" }));

    expect(def!.prompt).toBe("PUBLIC ONLY");
  });

  it("aliases the lead session marker to the default agent definition", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "default.md"),
      `---\nname: default\ncommon: core\n---\n\nDEFAULT BODY`,
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    const def = await router.resolveAgent(makeSession({ agentType: "lead" }));

    expect(def).not.toBeNull();
    expect(def!.name).toBe("default");
    expect(def!.prompt).toBe("DEFAULT BODY");
  });

  it("aliases the retired thinker marker to the default agent definition", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "default.md"),
      `---\nname: default\ncommon: core\n---\n\nDEFAULT BODY`,
    );

    const router = new AgentRouter([], fallbackDir, orgDir);
    const def = await router.resolveAgent(makeSession({ agentType: "thinker" }));

    expect(def!.name).toBe("default");
    expect(def!.prompt).toBe("DEFAULT BODY");
  });

  it("appends pipeline preambles for lead/thinker sessions but not default sessions", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "default.md"),
      `---\nname: default\ncommon: core\n---\n\nDEFAULT BODY`,
    );
    await fs.writeFile(
      path.join(fallbackDir, "common", "bug-pipeline.md"),
      "# BUG PIPELINE PLAYBOOK",
    );
    await fs.writeFile(
      path.join(fallbackDir, "common", "merge-workflow.md"),
      "# MERGE WORKFLOW RULES",
    );
    await fs.writeFile(
      path.join(fallbackDir, "common", "runtime-environment.md"),
      "# RUNTIME ENVIRONMENT",
    );

    const router = new AgentRouter([], fallbackDir, orgDir);

    // Support-channel session (marker "lead") gets the pipeline preambles —
    // merge-workflow and runtime-environment ride along because the pipeline's
    // merge step and dev-server/bug-folder contracts live there — after the
    // declared profile (core).
    const leadPrompt = await router.composeSystemPrompt(
      makeSession({ agentType: "lead" }),
    );
    expect(leadPrompt).toContain("# public core");
    expect(leadPrompt).toContain("# BUG PIPELINE PLAYBOOK");
    expect(leadPrompt).toContain("# MERGE WORKFLOW RULES");
    expect(leadPrompt).toContain("# RUNTIME ENVIRONMENT");
    expect(leadPrompt).toContain("DEFAULT BODY");
    expect(leadPrompt!.indexOf("# public core")).toBeLessThan(
      leadPrompt!.indexOf("# BUG PIPELINE PLAYBOOK"),
    );

    // Resumed pre-merge "thinker" sessions get the same pipeline preambles.
    const thinkerPrompt = await router.composeSystemPrompt(
      makeSession({ agentType: "thinker" }),
    );
    expect(thinkerPrompt).toContain("# BUG PIPELINE PLAYBOOK");
    expect(thinkerPrompt).toContain("# MERGE WORKFLOW RULES");

    // Casual default session carries none of the pipeline preambles.
    const defaultPrompt = await router.composeSystemPrompt(
      makeSession({ agentType: "default" }),
    );
    expect(defaultPrompt).toContain("DEFAULT BODY");
    expect(defaultPrompt).not.toContain("# BUG PIPELINE PLAYBOOK");
    expect(defaultPrompt).not.toContain("# MERGE WORKFLOW RULES");
    expect(defaultPrompt).not.toContain("# RUNTIME ENVIRONMENT");
  });

  it("missing org overlay dir degrades to public fallback", async () => {
    await fs.writeFile(
      path.join(fallbackDir, "build.md"),
      `---\nname: build\ncommon: public-rules\n---\n\nPUBLIC ONLY`,
    );
    await fs.writeFile(
      path.join(fallbackDir, "common", "public-rules.md"),
      "# public common",
    );

    const missingOrgDir = path.join(tmpRoot, "agents-org-missing");
    const router = new AgentRouter([], fallbackDir, missingOrgDir);

    const def = await router.resolveAgent(makeSession({ agentType: "build" }));
    const prompt = await router.composeSystemPrompt(
      makeSession({ agentType: "build" }),
    );

    expect(def!.prompt).toBe("PUBLIC ONLY");
    expect(prompt).toContain("# public common");
    expect(prompt).toContain("PUBLIC ONLY");
  });
});
