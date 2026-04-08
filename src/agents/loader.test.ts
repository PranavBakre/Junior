import { describe, it, expect } from "bun:test";
import { loadAgentDefinition } from "./loader.ts";
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
});
