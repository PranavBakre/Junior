import { describe, it, expect } from "bun:test";
import { loadAgentDefinition, DEFAULT_CONTEXT_PROFILE } from "./loader.ts";
import path from "node:path";

const agentsDir = path.resolve(
  import.meta.dir,
  "../../.claude/agents",
);

describe("loadAgentDefinition", () => {
  it("loads an existing .md file (build.md)", async () => {
    const def = await loadAgentDefinition(path.join(agentsDir, "build.md"));
    expect(def).not.toBeNull();
    expect(def!.name).toBe("build");
    expect(def!.description).toContain("Backend engineer");
    expect(def!.prompt).toContain("# build");
  });

  it("returns null for non-existent file", async () => {
    const def = await loadAgentDefinition(
      path.join(agentsDir, "nonexistent-agent.md"),
    );
    expect(def).toBeNull();
  });

  it("parses frontmatter correctly (name, description, tools, model)", async () => {
    const def = await loadAgentDefinition(path.join(agentsDir, "build.md"));
    expect(def).not.toBeNull();
    expect(def!.name).toBe("build");
    expect(def!.description).toBe(
      "Backend engineer. Use for building features, fixing bugs, refactoring code.",
    );
    expect(def!.tools).toBe("Read, Edit, Write, Bash, Grep, Glob, Agent");
    expect(def!.model).toBe("opus");
  });

  it("body is the content after the second ---", async () => {
    const def = await loadAgentDefinition(path.join(agentsDir, "build.md"));
    expect(def).not.toBeNull();
    // Body should start with the heading after frontmatter
    expect(def!.prompt).toMatch(/^# build/);
    // Body should not contain frontmatter delimiters or frontmatter fields
    expect(def!.prompt).not.toContain("---");
    expect(def!.prompt).not.toMatch(/^name:/m);
  });

  it("handles file with no frontmatter", async () => {
    // Write a temp file with no frontmatter
    const tmpPath = path.join(import.meta.dir, "__test_no_frontmatter.md");
    await Bun.write(tmpPath, "Just some content without frontmatter.");

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def).not.toBeNull();
      expect(def!.name).toBe("");
      expect(def!.description).toBe("");
      expect(def!.tools).toBeNull();
      expect(def!.model).toBeNull();
      expect(def!.prompt).toBe("Just some content without frontmatter.");
    } finally {
      const fs = await import("node:fs/promises");
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("handles frontmatter with quoted values", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_quoted.md");
    const content = `---
name: "test-agent"
description: 'A test agent'
tools: "Read, Write"
model: "sonnet"
---

Test body content.`;
    await Bun.write(tmpPath, content);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def).not.toBeNull();
      expect(def!.name).toBe("test-agent");
      expect(def!.description).toBe("A test agent");
      expect(def!.tools).toBe("Read, Write");
      expect(def!.model).toBe("sonnet");
      expect(def!.prompt).toBe("Test body content.");
    } finally {
      const fs = await import("node:fs/promises");
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("handles incomplete frontmatter (missing closing ---)", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_incomplete.md");
    const content = `---
name: broken
This has no closing delimiter`;
    await Bun.write(tmpPath, content);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def).not.toBeNull();
      // Should fall back to treating whole content as body
      expect(def!.name).toBe("");
      expect(def!.prompt).toContain("---");
    } finally {
      const fs = await import("node:fs/promises");
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  describe("context profile", () => {
    it("defaults all flags to true when no context.* keys are declared", async () => {
      const def = await loadAgentDefinition(path.join(agentsDir, "build.md"));
      expect(def).not.toBeNull();
      expect(def!.context).toEqual(DEFAULT_CONTEXT_PROFILE);
    });

    it("parses individual context.* flags as overrides", async () => {
      const tmpPath = path.join(import.meta.dir, "__test_ctx.md");
      const content = `---
name: pr-summarize
description: Summarize a PR in one sentence.
context.workspace: false
context.threadHistory: false
---

body`;
      await Bun.write(tmpPath, content);

      try {
        const def = await loadAgentDefinition(tmpPath);
        expect(def).not.toBeNull();
        expect(def!.context.identity).toBe(true);
        expect(def!.context.slack).toBe(true);
        expect(def!.context.workspace).toBe(false);
        expect(def!.context.threadHistory).toBe(false);
        expect(def!.context.agentState).toBe(true);
      } finally {
        const fs = await import("node:fs/promises");
        await fs.unlink(tmpPath).catch(() => {});
      }
    });

    it("ignores invalid context.* values (not 'true'/'false')", async () => {
      const tmpPath = path.join(import.meta.dir, "__test_ctx_bad.md");
      const content = `---
name: bad
context.workspace: maybe
context.threadHistory: 0
---
body`;
      await Bun.write(tmpPath, content);

      try {
        const def = await loadAgentDefinition(tmpPath);
        // Bad values fall back to default (true) — safe-but-heavy.
        expect(def!.context.workspace).toBe(true);
        expect(def!.context.threadHistory).toBe(true);
      } finally {
        const fs = await import("node:fs/promises");
        await fs.unlink(tmpPath).catch(() => {});
      }
    });
  });
});
