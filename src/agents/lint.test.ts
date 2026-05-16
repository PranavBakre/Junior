import { describe, it, expect } from "bun:test";
import { loadAgentDefinition } from "./loader.ts";
import path from "node:path";
import fs from "node:fs/promises";

const agentsDir = path.resolve(import.meta.dir, "../../.claude/agents");
const commonDir = path.join(agentsDir, "common");

const BUG_PIPELINE_AGENTS = ["lead", "thinker", "reproducer", "review"];
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

describe("prompt lint", () => {
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
      const def = await loadAgentDefinition(path.join(agentsDir, `${name}.md`));
      expect(def).not.toBeNull();
      expect(def!.context.threadHistory).toEqual(expect.any(Boolean));
    });

    it.each(ALL_PUBLIC_AGENTS)("%s has context.workspace frontmatter", async (name) => {
      const def = await loadAgentDefinition(path.join(agentsDir, `${name}.md`));
      expect(def).not.toBeNull();
      expect(def!.context.workspace).toEqual(expect.any(Boolean));
    });

    it.each(ALL_PUBLIC_AGENTS)("%s has context.agentState frontmatter", async (name) => {
      const def = await loadAgentDefinition(path.join(agentsDir, `${name}.md`));
      expect(def).not.toBeNull();
      expect(def!.context.agentState).toEqual(expect.any(Boolean));
    });
  });

  describe("all public agents have Done means section", () => {
    it.each(ALL_PUBLIC_AGENTS)("%s.md contains '## Done means'", async (name) => {
      const content = await fs.readFile(path.join(agentsDir, `${name}.md`), "utf-8");
      expect(content).toContain("## Done means");
    });
  });

  describe("bug-pipeline agents have output templates", () => {
    it.each(BUG_PIPELINE_AGENTS)("%s.md contains output format section", async (name) => {
      const content = await fs.readFile(path.join(agentsDir, `${name}.md`), "utf-8");
      // Each pipeline agent should document its output format
      const hasOutputSection =
        content.includes("## Output") ||
        content.includes("## Message 1") ||
        content.includes("## Message 2") ||
        content.includes("### 2. Post to Slack") ||
        content.includes("Allow-list — post only");
      expect(hasOutputSection).toBe(true);
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
