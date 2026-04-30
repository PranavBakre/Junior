import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "../config.ts";
import { WorktreeManager } from "./manager.ts";

// Real-fs integration test. We create a tiny git repo in a tmpdir and let
// WorktreeManager run actual git commands against it, plus a fake
// worktreeSetupCommand script we can verify by side effects.

let repoRoot: string;
let setupMarker: string;

beforeAll(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "junior-wt-test-"));

  // Init a bare-but-usable git repo with one commit on `main`.
  const run = async (args: string[]) => {
    const proc = Bun.spawn(args, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`${args.join(" ")} failed: ${err}`);
    }
  };
  await run(["git", "init", "-q", "-b", "main"]);
  await run(["git", "config", "user.email", "test@example.com"]);
  await run(["git", "config", "user.name", "test"]);
  writeFileSync(join(repoRoot, "README.md"), "hello\n");
  await run(["git", "add", "."]);
  await run(["git", "commit", "-q", "-m", "init"]);
  // Add a second commit on a different ref so we can test baseRef forwarding.
  await run(["git", "checkout", "-q", "-b", "feature/seeded"]);
  writeFileSync(join(repoRoot, "FEATURE.md"), "feature only\n");
  await run(["git", "add", "."]);
  await run(["git", "commit", "-q", "-m", "feature only"]);
  await run(["git", "checkout", "-q", "main"]);
  // Set up a fake `origin` remote pointing at ourselves so `git fetch origin` succeeds.
  await run(["git", "remote", "add", "origin", repoRoot]);
  await run(["git", "fetch", "-q", "origin"]);

  // Fake setup script: writes a marker file, then creates the worktree itself
  // so `WorktreeManager.createWorktree` returns successfully (the contract is
  // "exit 0 means done").
  setupMarker = join(repoRoot, "setup-marker.txt");
  const setupScript = join(repoRoot, "fake-setup.sh");
  writeFileSync(
    setupScript,
    `#!/usr/bin/env bash
set -e
echo "$1 $2" > "${setupMarker}"
git worktree add -b "$2" "$1" main >/dev/null 2>&1
`,
  );
  chmodSync(setupScript, 0o755);

  // Failing setup script.
  const failScript = join(repoRoot, "fail-setup.sh");
  writeFileSync(failScript, `#!/usr/bin/env bash\necho "permission denied" >&2\nexit 1\n`);
  chmodSync(failScript, 0o755);
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("WorktreeManager.createWorktree", () => {
  it("falls back to git worktree add when worktreeSetupCommand is not set", async () => {
    const repos: RepoConfig[] = [
      { name: "default-flow", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    const wtPath = await wm.createWorktree("default-flow", "default-thread");
    expect(wtPath).toBe(join(repoRoot, ".claude/worktrees/slack-default-thread"));
    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);

    await wm.removeWorktree("default-flow", "default-thread");
  });

  it("delegates to worktreeSetupCommand when configured", async () => {
    const repos: RepoConfig[] = [
      {
        name: "custom-flow",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "fake-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    if (existsSync(setupMarker)) rmSync(setupMarker);

    const wtPath = await wm.createWorktree("custom-flow", "custom-thread");

    // The script wrote the marker — confirms it ran with the right args.
    expect(existsSync(setupMarker)).toBe(true);
    const marker = await Bun.file(setupMarker).text();
    expect(marker.trim()).toBe(
      `${join(repoRoot, ".claude/worktrees/slack-custom-thread")} slack/custom-thread`,
    );
    expect(wtPath).toBe(join(repoRoot, ".claude/worktrees/slack-custom-thread"));

    await wm.removeWorktree("custom-flow", "custom-thread");
  });

  it("throws when worktreeSetupCommand exits non-zero", async () => {
    const repos: RepoConfig[] = [
      {
        name: "fail-flow",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "fail-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    await expect(wm.createWorktree("fail-flow", "fail-thread")).rejects.toThrow(
      /fail-setup\.sh failed/,
    );
  });

  it("forwards baseRef as the worktree's starting point (not as branch name)", async () => {
    const repos: RepoConfig[] = [
      { name: "baseref-flow", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    const wtPath = await wm.createWorktree(
      "baseref-flow",
      "baseref-thread",
      "feature/seeded",
    );

    // Worktree should have started from the seeded feature branch, so
    // FEATURE.md (only on feature/seeded) is present.
    expect(existsSync(join(wtPath, "FEATURE.md"))).toBe(true);

    // But the new branch is still the default thread-keyed name.
    const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: wtPath,
      stdout: "pipe",
    });
    await branchProc.exited;
    const currentBranch = (await new Response(branchProc.stdout).text()).trim();
    expect(currentBranch).toBe("slack/baseref-thread");

    await wm.removeWorktree("baseref-flow", "baseref-thread");
  });

  it("uses branchOverride for the new branch name (independent of baseRef)", async () => {
    const repos: RepoConfig[] = [
      { name: "branch-override-flow", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    const wtPath = await wm.createWorktree(
      "branch-override-flow",
      "override-thread",
      undefined, // baseRef defaults to repo.defaultBase (origin/main)
      "fix/custom-name", // branchOverride
    );

    const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: wtPath,
      stdout: "pipe",
    });
    await branchProc.exited;
    const currentBranch = (await new Response(branchProc.stdout).text()).trim();
    expect(currentBranch).toBe("fix/custom-name");

    // From origin/main: README.md present, FEATURE.md absent.
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);
    expect(existsSync(join(wtPath, "FEATURE.md"))).toBe(false);

    // removeWorktree must read the actual branch name and clean it up,
    // not assume `slack/<threadId>`.
    await wm.removeWorktree("branch-override-flow", "override-thread");

    // Verify the override branch is gone.
    const listProc = Bun.spawn(["git", "branch", "--list", "fix/custom-name"], {
      cwd: repoRoot,
      stdout: "pipe",
    });
    await listProc.exited;
    const listed = (await new Response(listProc.stdout).text()).trim();
    expect(listed).toBe("");
  });
});
