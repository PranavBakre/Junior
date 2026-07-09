import { describe, it, expect } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";

const agentsDir = path.resolve(import.meta.dir, "../../.claude/agents");
const commonDir = path.join(agentsDir, "common");

// Persistent workers still lint their own .md output templates. The
// orchestrator's bug-pipeline playbook (formerly split across lead.md +
// thinker.md) now lives in common/bug-pipeline.md and is linted separately.
const BUG_PIPELINE_AGENTS = ["reproducer", "review"];
const PUBLIC_AGENT_THREAD_HISTORY_LIMIT = 20;
const ALL_PUBLIC_AGENTS = [
  "architect",
  "build",
  "default",
  "frontend",
  "pm",
  "reproducer",
  "review",
];
const BUG_PIPELINE_OUTPUT_MARKERS: Record<string, string[]> = {
  reproducer: ["### 2. Post to Slack"],
  review: ["## Output", "review: <verdict>"],
};

// The merged orchestrator playbook lives in one common preamble. These are the
// load-bearing structural markers: the silence allow-list, the two-turn human
// gate messages, the Phase-1 pick line, and the byte-exact terminal merge string.
const BUG_PIPELINE_COMMON_MARKERS = [
  "Allow-list — post only",
  "### Message 1",
  "### Message 2",
  "Going with #<n>:",
  "Merged feature → dev (PR <url>). PR <main-pr-url> is ready for human to verify on dev and then merge to main.",
];

describe("prompt lint", () => {
  async function readAgent(name: string): Promise<string> {
    return fs.readFile(path.join(agentsDir, `${name}.md`), "utf-8");
  }

  describe("core.md budget", () => {
    const CORE_BUDGET_CHARS = 2500;

    it("common/core.md exists", async () => {
      const corePath = path.join(commonDir, "core.md");
      const exists = await fs.stat(corePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it(`common/core.md stays under ${CORE_BUDGET_CHARS} characters`, async () => {
      const corePath = path.join(commonDir, "core.md");
      const content = await fs.readFile(corePath, "utf-8");
      expect(content.length).toBeLessThanOrEqual(CORE_BUDGET_CHARS);
    });
  });

  describe("all public agents declare context budget", () => {
    it.each(ALL_PUBLIC_AGENTS)("%s has context.threadHistory frontmatter", async (name) => {
      const content = await readAgent(name);
      expect(content).toMatch(/^context\.threadHistory:\s*(true|false)\s*$/m);
    });

    it.each(ALL_PUBLIC_AGENTS)("%s has context.threadHistoryLimit frontmatter", async (name) => {
      const content = await readAgent(name);
      expect(content).toMatch(/^context\.threadHistoryLimit:\s*[1-9]\d*\s*$/m);
      const match = content.match(/^context\.threadHistoryLimit:\s*(\d+)\s*$/m);
      expect(Number(match?.[1])).toBeLessThanOrEqual(
        PUBLIC_AGENT_THREAD_HISTORY_LIMIT,
      );
    });

    it.each(ALL_PUBLIC_AGENTS)("%s has context.workspace frontmatter", async (name) => {
      const content = await readAgent(name);
      expect(content).toMatch(/^context\.workspace:\s*(true|false)\s*$/m);
    });

    it.each(ALL_PUBLIC_AGENTS)("%s has context.agentState frontmatter", async (name) => {
      const content = await readAgent(name);
      expect(content).toMatch(/^context\.agentState:\s*(true|false)\s*$/m);
    });
  });

  describe("all public agents have Done means section", () => {
    it.each(ALL_PUBLIC_AGENTS)("%s.md contains '## Done means'", async (name) => {
      const content = await readAgent(name);
      expect(content).toContain("## Done means");
    });
  });

  describe("bug-pipeline agents have output templates", () => {
    it.each(BUG_PIPELINE_AGENTS)("%s.md contains required output markers", async (name) => {
      const content = await readAgent(name);
      for (const marker of BUG_PIPELINE_OUTPUT_MARKERS[name] ?? []) {
        expect(content).toContain(marker);
      }
    });
  });

  describe("common/bug-pipeline.md carries the merged orchestrator playbook", () => {
    it.each(BUG_PIPELINE_COMMON_MARKERS)("contains marker %p", async (marker) => {
      const content = await fs.readFile(
        path.join(commonDir, "bug-pipeline.md"),
        "utf-8",
      );
      expect(content).toContain(marker);
    });
  });

  describe("action classifier present in core.md", () => {
    it("core.md contains the action classifier heading", async () => {
      const corePath = path.join(commonDir, "core.md");
      const content = await fs.readFile(corePath, "utf-8");
      expect(content).toMatch(/## First step: infer the required action/);
    });

    it("core.md contains implicit action examples", async () => {
      const corePath = path.join(commonDir, "core.md");
      const content = await fs.readFile(corePath, "utf-8");
      expect(content).toMatch(/\| "can you check X" \|/);
      expect(content).toMatch(/\| "why is this broken\?" \|/);
      expect(content).toMatch(/\| "review this PR" \|/);
      expect(content).toMatch(/\| "fix this" \|/);
    });
  });
});
