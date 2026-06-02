import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { WorkflowRegistry } from "./registry.ts";

const repos = [{ name: "junior", path: "/tmp/junior", defaultBase: "main" }];

describe("WorkflowRegistry", () => {
  it("lets overlay workflows override public workflows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-"));
    try {
      const publicRoot = join(dir, "workflows");
      const overlayRoot = join(dir, "agents-org", "workflows");
      await mkdir(publicRoot, { recursive: true });
      await mkdir(overlayRoot, { recursive: true });
      await Bun.write(join(publicRoot, "worklog.workflow.md"), workflowFile({
        description: "public",
        command: "worklog",
      }));
      await Bun.write(join(overlayRoot, "worklog.workflow.md"), workflowFile({
        description: "overlay",
        command: "private-worklog",
      }));

      const registry = new WorkflowRegistry({
        repos,
        roots: [
          { path: publicRoot, sourceRoot: "public" },
          { path: overlayRoot, sourceRoot: "overlay" },
        ],
      });

      await registry.reload();

      expect(registry.get("worklog")?.description).toBe("overlay");
      expect(registry.get("worklog")?.sourceRoot).toBe("overlay");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps last-known-good overlay when an edited overlay becomes invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-"));
    try {
      const publicRoot = join(dir, "workflows");
      const overlayRoot = join(dir, "agents-org", "workflows");
      const overlayPath = join(overlayRoot, "worklog.workflow.md");
      await mkdir(publicRoot, { recursive: true });
      await mkdir(overlayRoot, { recursive: true });
      await Bun.write(join(publicRoot, "worklog.workflow.md"), workflowFile({
        description: "public",
        command: "worklog",
      }));
      await Bun.write(overlayPath, workflowFile({
        description: "overlay",
        command: "private-worklog",
      }));

      const registry = new WorkflowRegistry({
        repos,
        roots: [
          { path: publicRoot, sourceRoot: "public" },
          { path: overlayRoot, sourceRoot: "overlay" },
        ],
      });

      await registry.reload();
      await Bun.write(overlayPath, "---\nname: mismatch\nenabled: true\n---\nbroken");
      await registry.reload();

      expect(registry.get("worklog")?.description).toBe("overlay");
      expect(registry.getErrors()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks public fallback on cold boot when an overlay exists but is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-"));
    try {
      const publicRoot = join(dir, "workflows");
      const overlayRoot = join(dir, "agents-org", "workflows");
      await mkdir(publicRoot, { recursive: true });
      await mkdir(overlayRoot, { recursive: true });
      await Bun.write(join(publicRoot, "worklog.workflow.md"), workflowFile({
        description: "public",
        command: "worklog",
      }));
      await Bun.write(
        join(overlayRoot, "worklog.workflow.md"),
        "---\nname: mismatch\nenabled: true\n---\nbroken",
      );

      const registry = new WorkflowRegistry({
        repos,
        roots: [
          { path: publicRoot, sourceRoot: "public" },
          { path: overlayRoot, sourceRoot: "overlay" },
        ],
      });

      await registry.reload();

      expect(registry.get("worklog")).toBeUndefined();
      expect(registry.getErrors()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function workflowFile(options: { description: string; command: string }): string {
  return [
    "---",
    "name: worklog",
    "enabled: true",
    `description: ${options.description}`,
    "ownerSlackUserIds:",
    "  - U123ABC",
    "triggers:",
    "  - type: command",
    `    command: ${options.command}`,
    "outputs:",
    "  - type: docs",
    "    path: data/workflow-runs/worklog",
    "permissions:",
    "  repos:",
    "    - junior",
    "  tools:",
    "    - docs.write",
    "---",
    "Summarize work.",
  ].join("\n");
}
