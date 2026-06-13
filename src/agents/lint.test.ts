import { describe, it, expect } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";

const agentsDir = path.resolve(import.meta.dir, "../../.claude/agents");
const commonDir = path.join(agentsDir, "common");

const BUG_PIPELINE_AGENTS = ["lead", "thinker", "reproducer", "review"];
const PUBLIC_AGENT_THREAD_HISTORY_LIMIT = 20;
const ALL_PUBLIC_AGENTS = [
  "architect",
  "build",
  "default",
  "frontend",
  "lead",
  "pm",
  "reproducer",
  "review",
  "thinker",
];
const BUG_PIPELINE_OUTPUT_MARKERS: Record<string, string[]> = {
  lead: ["Allow-list — post only"],
  thinker: ["### Message 1", "### Message 2"],
  reproducer: ["### 2. Post to Slack"],
  review: ["## Output", "review: <verdict>"],
};

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

  describe("bug-pipeline agents implement adaptive evidence routing", () => {
    it("lead prompt uses adaptive path selection instead of universal observability", async () => {
      const content = await readAgent("lead");

      expect(content).toContain("adaptive step selection");
      expect(content).toContain("Evidence paths");
      expect(content).toContain("targeted/full/no observability");
      expect(content).toContain("Skipping <agent/check> because <reason>");
      expect(content).not.toContain("EVERY bug, no exceptions");
      expect(content).not.toContain("Observability always precedes reproduction and validation");
    });

    it("reproducer prompt allows adaptive terminal outcomes and modes", async () => {
      const content = await readAgent("reproducer");

      for (const marker of [
        "image-interpretation",
        "entitlement-check",
        "read-only-walk",
        "expected-behavior",
        "data-issue",
        "product-bug",
        "needs-human",
      ]) {
        expect(content).toContain(marker);
      }

      expect(content).not.toContain("<reproduced | partial | mismatch | not-reproduced>");
      expect(content).not.toContain("Honest about what was seen: `reproduced`, `partial`, `mismatch`, or `not-reproduced`");
    });

    it("thinker and review prompts honor requested depth", async () => {
      const thinker = await readAgent("thinker");
      const review = await readAgent("review");

      for (const marker of ["triage", "focused", "full", "data-repair", "known-fix"]) {
        expect(thinker).toContain(marker);
      }

      for (const marker of ["micro", "standard", "deep", "Escalate to `deep`"]) {
        expect(review).toContain(marker);
      }
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
