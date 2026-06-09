import type { RepoConfig } from "../config.ts";

export interface WorktreeStatus {
  tracked: string[];
  untracked: string[];
}

export class WorktreeManager {
  private repos: RepoConfig[];

  constructor(repos: RepoConfig[]) {
    this.repos = repos;
  }

  /**
   * Create a worktree in the target repo for a thread.
   *
   * - `baseRef` is the starting point (a git ref/commit like `origin/main`).
   *   Defaults to `repo.defaultBase` on both the inline and delegated paths.
   * - `branchOverride` renames the new branch the worktree tracks. Defaults
   *   to `slack/<threadId>`. The two are independent — pass `branchOverride`
   *   to name the branch differently from the default thread-keyed slug,
   *   pass `baseRef` to fork from a non-main starting point.
   *
   * Setup-script delegation contract:
   *   `<repo.path>/<command> <branch> --path <abs> --base <ref>`
   *
   * Returns the worktree path.
   */
  async createWorktree(
    repoName: string,
    threadId: string,
    baseRef?: string,
    branchOverride?: string,
  ): Promise<string> {
    const repo = this.getRepo(repoName);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoName}`);
    }

    const worktreePath = this.getWorktreePath(repoName, threadId);
    const branchName = branchOverride ?? `slack/${threadId}`;

    if (repo.worktreeSetupCommand) {
      // Delegate worktree creation to the repo's setup script. The script
      // owns `git fetch`, `git worktree add`, env-file copying, dependency
      // install, and MCP migration. Junior hands it the branch, the absolute
      // target path, and the base ref (always — defaulting to repo.defaultBase
      // so the script's own HEAD-based fallback is never reached).
      const setupCmd = repo.worktreeSetupCommand.startsWith("/")
        ? repo.worktreeSetupCommand
        : `${repo.path}/${repo.worktreeSetupCommand}`;
      const base = baseRef ?? repo.defaultBase;
      const args = [setupCmd, branchName, "--path", worktreePath, "--base", base];
      await this.runCommand(args, repo.path);
    } else {
      // No setup hook configured — Junior creates the worktree inline. Fetch
      // fresh first so the base ref is up to date, then `git worktree add`.
      const base = baseRef ?? repo.defaultBase;
      await this.runGit(["fetch", "origin", "--prune"], repo.path);
      await this.runGit(
        ["worktree", "add", worktreePath, "-b", branchName, base],
        repo.path,
      );
    }

    return worktreePath;
  }

  /**
   * Remove a worktree and clean up its branch. Queries the worktree for its
   * actual branch name before deletion so callers that used `branchOverride`
   * at creation are still cleaned up correctly (and as a fallback if the
   * worktree was created externally and then registered).
   */
  async removeWorktree(
    repoName: string,
    threadId: string
  ): Promise<void> {
    const repo = this.getRepo(repoName);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoName}`);
    }

    const worktreePath = this.getWorktreePath(repoName, threadId);

    // Read the actual branch name from the worktree before we remove it.
    // Falls back to the thread-keyed default if the worktree is missing or
    // detached — the branch -D below will be a no-op in that case.
    let branchName = `slack/${threadId}`;
    try {
      const out = await this.runGit(
        ["branch", "--show-current"],
        worktreePath,
      );
      const detected = out.trim();
      if (detected) branchName = detected;
    } catch {
      // worktree path is gone or not a git checkout — proceed with default
    }

    // Force-remove the worktree
    await this.runGit(
      ["worktree", "remove", worktreePath, "--force"],
      repo.path
    );

    // Clean up the branch (no-op if it doesn't exist)
    try {
      await this.runGit(["branch", "-D", branchName], repo.path);
    } catch {
      // branch may not exist — non-fatal
    }
  }

  /**
   * Check if a worktree directory exists for a thread.
   */
  async worktreeExists(
    repoName: string,
    threadId: string
  ): Promise<boolean> {
    const worktreePath = this.getWorktreePath(repoName, threadId);
    try {
      const { stat } = await import("node:fs/promises");
      const s = await stat(worktreePath);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Check if a worktree has uncommitted changes.
   */
  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    const output = await this.runGit(["status", "--porcelain"], worktreePath);
    return output.trim().length > 0;
  }

  async getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
    const output = await this.runGit(["status", "--porcelain"], worktreePath);
    const status: WorktreeStatus = { tracked: [], untracked: [] };
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const path = line.slice(3).trim();
      if (!path) continue;
      if (line.startsWith("?? ")) {
        status.untracked.push(path);
      } else {
        status.tracked.push(path);
      }
    }
    return status;
  }

  /**
   * Get the worktree path for a thread (without creating it).
   *
   * Worktrees live in a sibling directory to the repo, NOT under `.claude/`.
   * Setup scripts that recursively copy `.claude/` (e.g. `cp -R .claude/.`)
   * would otherwise pull every sibling thread's worktree — and the destination
   * itself — into a freshly-creating worktree, producing a recursive copy
   * that loops on its own destination.
   */
  getWorktreePath(repoName: string, threadId: string): string {
    const repo = this.getRepo(repoName);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoName}`);
    }
    // Strip trailing slashes — without this, a config with `path: "/r/"` would
    // resolve to `/r/.junior-worktrees/...`, a hidden subdir INSIDE the repo
    // rather than a sibling, recreating the recursive-copy bug. Belt-and-
    // suspenders with the same normalization at config load.
    const base = repo.path.replace(/\/+$/, "");
    return `${base}.junior-worktrees/slack-${threadId}`;
  }

  getBranchName(threadId: string): string {
    return `slack/${threadId}`;
  }

  /**
   * Find a repo config by name.
   */
  getRepo(name: string): RepoConfig | undefined {
    return this.repos.find((r) => r.name === name);
  }

  /**
   * Run a git command and return stdout. Throws on non-zero exit.
   */
  private async runGit(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
    }
    return await new Response(proc.stdout).text();
  }

  /**
   * Run an arbitrary command (e.g. a worktreeSetupCommand script) in `cwd`.
   * The first element is the command; remaining elements are args.
   * Throws on non-zero exit.
   */
  private async runCommand(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`command ${args[0]} failed: ${stderr.trim()}`);
    }
    return await new Response(proc.stdout).text();
  }
}
