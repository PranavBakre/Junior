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
        verifyProvenance: false,
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
        verifyProvenance: false,
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

  it("pauses watch reloads and reloads once on resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-"));
    try {
      const publicRoot = join(dir, "workflows");
      const overlayRoot = join(dir, "agents-org", "workflows");
      const overlayPath = join(overlayRoot, "worklog.workflow.md");
      await mkdir(publicRoot, { recursive: true });
      await mkdir(overlayRoot, { recursive: true });
      await Bun.write(overlayPath, workflowFile({
        description: "overlay",
        command: "private-worklog",
      }));

      const registry = new WorkflowRegistry({
        repos,
        verifyProvenance: false,
        roots: [
          { path: publicRoot, sourceRoot: "public" },
          { path: overlayRoot, sourceRoot: "overlay" },
        ],
        debounceMs: 20,
      });
      let reloads = 0;
      registry.onEvent((event) => {
        if (event.type === "reloaded") reloads += 1;
      });
      await registry.startWatching();
      expect(registry.get("worklog")?.description).toBe("overlay");
      const afterStart = reloads;

      registry.pauseReloads();
      registry.pauseReloads();
      await Bun.write(overlayPath, "---\nname: mismatch\nenabled: true\n---\nbroken");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(reloads).toBe(afterStart);
      expect(registry.get("worklog")?.description).toBe("overlay");
      expect(registry.getErrors()).toHaveLength(0);

      await registry.resumeReloads();
      expect(reloads).toBe(afterStart);
      expect(registry.getErrors()).toHaveLength(0);

      await registry.resumeReloads();
      expect(reloads).toBe(afterStart + 1);
      expect(registry.get("worklog")?.description).toBe("overlay");
      expect(registry.getErrors()).toHaveLength(1);
      registry.stopWatching();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips reload when resumeReloads({ reload: false })", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-"));
    try {
      const overlayRoot = join(dir, "agents-org", "workflows");
      const overlayPath = join(overlayRoot, "worklog.workflow.md");
      await mkdir(overlayRoot, { recursive: true });
      await Bun.write(overlayPath, workflowFile({
        description: "overlay",
        command: "private-worklog",
      }));
      const registry = new WorkflowRegistry({
        repos,
        verifyProvenance: false,
        roots: [{ path: overlayRoot, sourceRoot: "overlay" }],
      });
      await registry.reload();
      registry.pauseReloads();
      await Bun.write(overlayPath, "---\nname: mismatch\nenabled: true\n---\nbroken");
      await registry.resumeReloads({ reload: false });
      expect(registry.get("worklog")?.description).toBe("overlay");
      expect(registry.getErrors()).toHaveLength(0);
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
        verifyProvenance: false,
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

  it("loads only a workflow whose blob is published on the default branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-git-"));
    try {
      const root = join(dir, "workflows");
      await mkdir(root, { recursive: true });
      const path = join(root, "worklog.workflow.md");
      await Bun.write(path, workflowFile({ description: "published", command: "worklog" }));
      await initGitRepo(dir);
      await git(dir, ["add", "workflows/worklog.workflow.md"]);
      await git(dir, ["commit", "-m", "publish workflow"]);

      const registry = new WorkflowRegistry({
        repos,
        roots: [{ path: root, sourceRoot: "public", defaultRef: "main" }],
      });
      await registry.reload();

      const definition = registry.get("worklog");
      expect(definition?.description).toBe("published");
      expect(definition?.verifiedCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(registry.getErrors()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps branch-only edits inactive and unpublished", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-git-"));
    try {
      const root = join(dir, "workflows");
      await mkdir(root, { recursive: true });
      const path = join(root, "worklog.workflow.md");
      await Bun.write(path, workflowFile({ description: "published", command: "worklog" }));
      await initGitRepo(dir);
      await git(dir, ["add", "workflows/worklog.workflow.md"]);
      await git(dir, ["commit", "-m", "publish workflow"]);
      const registry = new WorkflowRegistry({
        repos,
        roots: [{ path: root, sourceRoot: "public", defaultRef: "main" }],
      });
      await registry.reload();
      expect(registry.get("worklog")?.description).toBe("published");
      await git(dir, ["switch", "-c", "feature"]);
      await Bun.write(path, workflowFile({ description: "branch-only", command: "worklog" }));

      await registry.reload();

      expect(registry.get("worklog")).toBeUndefined();
      expect(registry.getErrors()[0]?.message).toContain("Workflow is unpublished");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an untracked definition inactive and unpublished", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-git-"));
    try {
      const root = join(dir, "workflows");
      await mkdir(root, { recursive: true });
      await initGitRepo(dir);
      await Bun.write(join(root, "untracked.workflow.md"), workflowFile({
        description: "untracked",
        command: "untracked",
      }).replaceAll("name: worklog", "name: untracked").replaceAll("worklog", "untracked"));

      const registry = new WorkflowRegistry({
        repos,
        roots: [{ path: root, sourceRoot: "public", defaultRef: "main" }],
      });
      await registry.reload();

      expect(registry.get("untracked")).toBeUndefined();
      expect(registry.getErrors()[0]?.message).toContain("Workflow is unpublished");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects index dirtiness even when the working-tree bytes match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-git-"));
    try {
      const root = join(dir, "workflows");
      await mkdir(root, { recursive: true });
      const path = join(root, "worklog.workflow.md");
      const published = workflowFile({ description: "published", command: "worklog" });
      await Bun.write(path, published);
      await initGitRepo(dir);
      await git(dir, ["add", "workflows/worklog.workflow.md"]);
      await git(dir, ["commit", "-m", "publish workflow"]);
      await Bun.write(path, workflowFile({ description: "staged", command: "worklog" }));
      await git(dir, ["add", "workflows/worklog.workflow.md"]);
      await Bun.write(path, published);

      const registry = new WorkflowRegistry({
        repos,
        roots: [{ path: root, sourceRoot: "public", defaultRef: "main" }],
      });
      await registry.reload();

      expect(registry.get("worklog")).toBeUndefined();
      expect(registry.getErrors()[0]?.message).toContain("working-tree or index is dirty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects rm-cached plus identical untracked workflow bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-git-"));
    try {
      const root = join(dir, "workflows");
      await mkdir(root, { recursive: true });
      const path = join(root, "worklog.workflow.md");
      await Bun.write(path, workflowFile({ description: "published", command: "worklog" }));
      await initGitRepo(dir);
      await git(dir, ["add", "workflows/worklog.workflow.md"]);
      await git(dir, ["commit", "-m", "publish workflow"]);
      await git(dir, ["rm", "--cached", "workflows/worklog.workflow.md"]);

      const registry = new WorkflowRegistry({
        repos,
        roots: [{ path: root, sourceRoot: "public", defaultRef: "main" }],
      });
      await registry.reload();

      expect(registry.get("worklog")).toBeUndefined();
      expect(registry.getErrors()[0]?.message).toContain("working-tree or index is dirty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not fall back to public when an overlay is unpublished", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflows-git-"));
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
        description: "unpublished overlay",
        command: "private-worklog",
      }));
      await initGitRepo(dir);
      await git(dir, ["add", "workflows/worklog.workflow.md"]);
      await git(dir, ["commit", "-m", "publish public workflow"]);

      const registry = new WorkflowRegistry({
        repos,
        roots: [
          { path: publicRoot, sourceRoot: "public", defaultRef: "main" },
          { path: overlayRoot, sourceRoot: "overlay", defaultRef: "main" },
        ],
      });
      await registry.reload();

      expect(registry.get("worklog")).toBeUndefined();
      expect(registry.getErrors()).toHaveLength(1);
      expect(registry.getErrors()[0]?.message).toContain("Workflow is unpublished");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function initGitRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

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
