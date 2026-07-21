import { describe, it, expect } from "bun:test";
import { loadAgentDefinition, DEFAULT_CONTEXT_PROFILE } from "./loader.ts";
import path from "node:path";
import fs from "node:fs/promises";

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

  it("parses frontmatter correctly (name, description, tools, common)", async () => {
    const def = await loadAgentDefinition(path.join(agentsDir, "build.md"));
    expect(def).not.toBeNull();
    expect(def!.name).toBe("build");
    expect(def!.description).toBe(
      "Backend engineer. Use for building features, fixing bugs, refactoring code.",
    );
    expect(def!.tools).toBe(
      "Read, Edit, Write, Bash, Grep, Glob, Agent, mcp__slack-bot__memory_recall",
    );
    expect(def!.model).toBeNull();
    expect(def!.common).toEqual([
      "core",
      "building-philosophy",
      "pipeline-outcome",
    ]);
    expect(def!.permissions).toEqual({
      intent: "normal",
      mcp: ["slack-bot"],
      tools: [
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Grep",
        "Glob",
        "Agent",
        "mcp__slack-bot__memory_recall",
      ],
    });
  });

  it("default agent explicitly keeps MongoDB MCP through Junior's proxy", async () => {
    const def = await loadAgentDefinition(path.join(agentsDir, "default.md"));

    expect(def).not.toBeNull();
    expect(def!.permissions.mcp).toContain("slack-bot");
    expect(def!.permissions.mcp).toContain("mongodb");
  });

  it("parses typed permission frontmatter", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_permissions_fm.md");
    const content = `---
name: readonly
description: Test
permissions.intent: read-only
permissions.mcp: slack-bot, playwright
---

body`;
    await Bun.write(tmpPath, content);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def).not.toBeNull();
      expect(def!.permissions).toEqual({
        intent: "read-only",
        mcp: ["slack-bot", "playwright"],
        tools: [],
      });
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("infers MCP permissions from Claude-style tool names", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_permissions_tools_fm.md");
    const content = `---
name: mcp-tools
description: Test
tools: Read, mcp__slack-bot__slack_send_message, mcp__mongodb__find, mcp__slack-bot__slack_read_thread
---

body`;
    await Bun.write(tmpPath, content);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def).not.toBeNull();
      expect(def!.permissions.mcp).toEqual(["slack-bot", "mongodb"]);
      expect(def!.permissions.tools).toContain("mcp__mongodb__find");
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("fails closed for unknown permission intent", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_permissions_unknown_fm.md");
    await Bun.write(tmpPath, `---
name: risky
description: Test
permission: all-the-things
---

body`);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def!.permissions.intent).toBe("no-tools");
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("parses optional username + iconEmoji/imageUrl frontmatter fields", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_identity_fm.md");
    const content = `---
name: example-worker
description: Test
username: Examplor
iconEmoji: ":wave:"
imageUrl: "https://example.com/icon.png"
---

body`;
    await Bun.write(tmpPath, content);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def).not.toBeNull();
      expect(def!.username).toBe("Examplor");
      expect(def!.iconEmoji).toBe(":wave:");
      expect(def!.imageUrl).toBe("https://example.com/icon.png");
    } finally {
      const fs = await import("node:fs/promises");
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("public fallback agents do not hardcode Opus model frontmatter", async () => {
    const entries = await fs.readdir(agentsDir);
    const offenders: string[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const content = await Bun.file(path.join(agentsDir, entry)).text();
      if (/^model:\s*opus\s*$/m.test(content)) offenders.push(entry);
    }

    expect(offenders).toEqual([]);
  });

  it("identity fields are null when not declared", async () => {
    const def = await loadAgentDefinition(path.join(agentsDir, "build.md"));
    expect(def).not.toBeNull();
    expect(def!.username).toBeNull();
    expect(def!.iconEmoji).toBeNull();
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
      expect(def!.common).toEqual(["core"]);
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
common: "core,building"
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
      expect(def!.common).toEqual(["core", "building"]);
      expect(def!.prompt).toBe("Test body content.");
    } finally {
      const fs = await import("node:fs/promises");
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("parses comma-separated common profile", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_common.md");
    const content = `---
name: common-test
common: core, building, runtime-environment
---

body`;
    await Bun.write(tmpPath, content);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def!.common).toEqual([
        "core",
        "building",
        "runtime-environment",
      ]);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("injects core first even when common profile omits or misorders it", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_common_core_first.md");
    const content = `---
name: common-test
common: runtime-environment, core, building
---

body`;
    await Bun.write(tmpPath, content);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def!.common).toEqual([
        "core",
        "runtime-environment",
        "building",
      ]);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("injects core when common profile omits it", async () => {
    const tmpPath = path.join(import.meta.dir, "__test_common_omit_core.md");
    const content = `---
name: common-test
common: building
---

body`;
    await Bun.write(tmpPath, content);

    try {
      const def = await loadAgentDefinition(tmpPath);
      expect(def!.common).toEqual(["core", "building"]);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  describe("modelClaude frontmatter field", () => {
    it("parses model.claude frontmatter into modelClaude", async () => {
      const tmpPath = path.join(import.meta.dir, "__test_model_claude.md");
      const content = `---
name: claude-override
description: Test
model: gpt-5.5
model.claude: sonnet
---

body`;
      await Bun.write(tmpPath, content);

      try {
        const def = await loadAgentDefinition(tmpPath);
        expect(def).not.toBeNull();
        expect(def!.model).toBe("gpt-5.5");
        expect(def!.modelClaude).toBe("sonnet");
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    });

    it("modelClaude is null when model.claude is not declared", async () => {
      const tmpPath = path.join(import.meta.dir, "__test_model_claude_absent.md");
      const content = `---
name: no-claude-override
description: Test
model: gpt-5.5
---

body`;
      await Bun.write(tmpPath, content);

      try {
        const def = await loadAgentDefinition(tmpPath);
        expect(def).not.toBeNull();
        expect(def!.modelClaude).toBeNull();
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    });
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
      const tmpPath = path.join(import.meta.dir, "__test_ctx_defaults.md");
      const content = `---
name: no-ctx-agent
description: No context frontmatter declared
---

body`;
      await Bun.write(tmpPath, content);

      try {
        const def = await loadAgentDefinition(tmpPath);
        expect(def).not.toBeNull();
        expect(def!.context).toEqual(DEFAULT_CONTEXT_PROFILE);
      } finally {
        const fs = await import("node:fs/promises");
        await fs.unlink(tmpPath).catch(() => {});
      }
    });

    it("parses individual context.* flags as overrides", async () => {
      const tmpPath = path.join(import.meta.dir, "__test_ctx.md");
      const content = `---
name: pr-summarize
description: Summarize a PR in one sentence.
context.workspace: false
context.threadHistory: false
context.threadHistoryLimit: 12
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
        expect(def!.context.threadHistoryLimit).toBe(12);
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
context.threadHistoryLimit: nope
---
body`;
      await Bun.write(tmpPath, content);

      try {
        const def = await loadAgentDefinition(tmpPath);
        // Bad values fall back to default (true) — safe-but-heavy.
        expect(def!.context.workspace).toBe(true);
        expect(def!.context.threadHistory).toBe(true);
        expect(def!.context.threadHistoryLimit).toBe(
          DEFAULT_CONTEXT_PROFILE.threadHistoryLimit,
        );
      } finally {
        const fs = await import("node:fs/promises");
        await fs.unlink(tmpPath).catch(() => {});
      }
    });
  });
});
