import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "../config.ts";
import { WorktreeManager } from "./manager.ts";

// Real-fs integration test. We create a tiny git repo in a tmpdir and let
// WorktreeManager run actual git commands against it, plus a fake
// post-create setup script we can verify by side effects.

let repoRoot: string;
let setupMarker: string;

// Helper: run a shell command in a given cwd, throwing on non-zero.
async function runIn(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${args.join(" ")} failed: ${err}`);
  }
}

beforeAll(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "junior-wt-test-"));

  // Init a bare-but-usable git repo with one commit on `main`.
  await runIn(repoRoot, ["git", "init", "-q", "-b", "main"]);
  await runIn(repoRoot, ["git", "config", "user.email", "test@example.com"]);
  await runIn(repoRoot, ["git", "config", "user.name", "test"]);
  writeFileSync(join(repoRoot, "README.md"), "hello\n");
  await runIn(repoRoot, ["git", "add", "."]);
  await runIn(repoRoot, ["git", "commit", "-q", "-m", "init"]);
  // Add a second commit on a different ref so we can test baseRef forwarding.
  await runIn(repoRoot, ["git", "checkout", "-q", "-b", "feature/seeded"]);
  writeFileSync(join(repoRoot, "FEATURE.md"), "feature only\n");
  await runIn(repoRoot, ["git", "add", "."]);
  await runIn(repoRoot, ["git", "commit", "-q", "-m", "feature only"]);
  await runIn(repoRoot, ["git", "checkout", "-q", "main"]);
  // Set up a fake `origin` remote pointing at ourselves so `git fetch origin` succeeds.
  await runIn(repoRoot, ["git", "remote", "add", "origin", repoRoot]);
  await runIn(repoRoot, ["git", "fetch", "-q", "origin"]);

  // Fake post-create setup script. Single argument: the absolute worktree
  // path. Junior has already created the worktree before this runs — the
  // script writes a marker file containing $1 to confirm it ran with the
  // right argument, and validates the new contract internally.
  setupMarker = join(repoRoot, "setup-marker.txt");
  const setupScript = join(repoRoot, "fake-setup.sh");
  writeFileSync(
    setupScript,
    `#!/usr/bin/env bash
set -e
# Validate single-arg contract: must be an existing absolute path directory.
if [[ "$1" != /* || ! -d "$1" ]]; then
  echo "fake-setup: expected absolute path to existing dir, got: $1" >&2
  exit 1
fi
# Reject extra args — new contract is single-arg.
if [[ -n "$2" ]]; then
  echo "fake-setup: unexpected second argument: $2" >&2
  exit 1
fi
echo "$1" > "${setupMarker}"
`,
  );
  chmodSync(setupScript, 0o755);

  // Failing setup script.
  const failScript = join(repoRoot, "fail-setup.sh");
  writeFileSync(
    failScript,
    `#!/usr/bin/env bash\necho "permission denied" >&2\nexit 1\n`,
  );
  chmodSync(failScript, 0o755);
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/**
 * Add a fresh commit on `main` (which is also the `origin` remote since
 * the test repo's origin self-references). The new file is only visible
 * via `origin/main` AFTER a fresh `git fetch origin`, so its presence in
 * a created worktree proves Junior fetched before `git worktree add`.
 *
 * Returns the filename written.
 */
async function addFreshCommitOnMain(label: string): Promise<string> {
  const filename = `freshness-${label}.md`;
  writeFileSync(join(repoRoot, filename), `${label}\n`);
  await runIn(repoRoot, ["git", "add", filename]);
  await runIn(repoRoot, ["git", "commit", "-q", "-m", `freshness ${label}`]);
  return filename;
}

describe("WorktreeManager.createWorktree", () => {
  it("creates worktree via git when worktreeSetupCommand is not set", async () => {
    const repos: RepoConfig[] = [
      { name: "default-flow", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    // Drop a fresh commit on main right before creating the worktree.
    // The worktree should pick it up only if Junior fetched first.
    const freshFile = await addFreshCommitOnMain("default-flow");

    const wtPath = await wm.createWorktree("default-flow", "default-thread");
    expect(wtPath).toBe(
      join(repoRoot, ".claude/worktrees/slack-default-thread"),
    );
    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);
    // Regression guard: fetch ran, so origin/main is fresh.
    expect(existsSync(join(wtPath, freshFile))).toBe(true);

    await wm.removeWorktree("default-flow", "default-thread");
  });

  it("runs setup hook with single arg AFTER creating the worktree", async () => {
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

    // Junior created the worktree itself before the hook ran.
    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);

    // Setup hook ran with single arg = abs worktree path. The script
    // validates the contract internally (abs path, exists, no $2) and
    // exits non-zero on violation, which would have failed createWorktree.
    expect(existsSync(setupMarker)).toBe(true);
    const marker = await Bun.file(setupMarker).text();
    expect(marker.trim()).toBe(
      join(repoRoot, ".claude/worktrees/slack-custom-thread"),
    );
    expect(wtPath).toBe(
      join(repoRoot, ".claude/worktrees/slack-custom-thread"),
    );

    await wm.removeWorktree("custom-flow", "custom-thread");
  });

  it("fetches origin even when worktreeSetupCommand is set (autofetch regression guard)", async () => {
    const repos: RepoConfig[] = [
      {
        name: "fetch-with-hook-flow",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "fake-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    if (existsSync(setupMarker)) rmSync(setupMarker);

    // Add a commit on main that's only visible after `git fetch origin`.
    const freshFile = await addFreshCommitOnMain("with-hook");

    const wtPath = await wm.createWorktree(
      "fetch-with-hook-flow",
      "fetch-thread",
    );

    // If Junior fetched before `git worktree add`, origin/main is current
    // and the worktree contains the new file. If fetch was skipped (the
    // old behaviour when worktreeSetupCommand was set), the file would
    // be absent.
    expect(existsSync(join(wtPath, freshFile))).toBe(true);
    // Hook still ran.
    expect(existsSync(setupMarker)).toBe(true);

    await wm.removeWorktree("fetch-with-hook-flow", "fetch-thread");
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

    await expect(
      wm.createWorktree("fail-flow", "fail-thread"),
    ).rejects.toThrow(/fail-setup\.sh failed/);

    // Worktree was created before the hook failed — clean up so any
    // future test runs against the same tmpdir start clean.
    await wm.removeWorktree("fail-flow", "fail-thread");
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
      {
        name: "branch-override-flow",
        path: repoRoot,
        defaultBase: "origin/main",
      },
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
    const listProc = Bun.spawn(
      ["git", "branch", "--list", "fix/custom-name"],
      { cwd: repoRoot, stdout: "pipe" },
    );
    await listProc.exited;
    const listed = (await new Response(listProc.stdout).text()).trim();
    expect(listed).toBe("");
  });
});
