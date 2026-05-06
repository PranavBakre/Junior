import type { RepoConfig } from "../config.ts";

export class WorktreeManager {
  private repos: RepoConfig[];

  constructor(repos: RepoConfig[]) {
    this.repos = repos;
  }

  /**
   * Create a worktree in the target repo for a thread.
   *
   * - `baseRef` is the starting point (a git ref/commit like `origin/main`).
   *   Defaults to `repo.defaultBase`. This becomes the worktree's HEAD.
   * - `branchOverride` renames the new branch the worktree tracks. Defaults
   *   to `slack/<threadId>`. The two are independent — pass `branchOverride`
   *   to name the branch differently from the default thread-keyed slug,
   *   pass `baseRef` to fork from a non-main starting point.
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
    const base = baseRef ?? repo.defaultBase;

    // Always create the worktree ourselves: fetch fresh, then add. The setup
    // command (if any) is a post-create hook, never the worktree creator.
    // Single flow keeps autofetch reliable across all paths and prevents the
    // "directory does not exist" failure mode when both sides assumed the
    // other would do `git worktree add`.
    await this.runGit(["fetch", "origin", "--prune"], repo.path);
    await this.runGit(
      ["worktree", "add", worktreePath, "-b", branchName, base],
      repo.path,
    );

    if (repo.worktreeSetupCommand) {
      // Post-create hook: env-file copying, dependency install, MCP migration.
      // Resolve the command relative to repo.path so paths like
      // "scripts/setup-worktree.sh" work without requiring the script on PATH.
      // Single argument: the absolute worktree path.
      const setupCmd = repo.worktreeSetupCommand.startsWith("/")
        ? repo.worktreeSetupCommand
        : `${repo.path}/${repo.worktreeSetupCommand}`;
      await this.runCommand([setupCmd, worktreePath], repo.path);
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

  /**
   * Get the worktree path for a thread (without creating it).
   */
  getWorktreePath(repoName: string, threadId: string): string {
    const repo = this.getRepo(repoName);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoName}`);
    }
    return `${repo.path}/.claude/worktrees/slack-${threadId}`;
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
