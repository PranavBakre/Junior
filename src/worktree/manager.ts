import type { RepoConfig } from "../config.ts";
import { statfs } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const DEFAULT_SETUP_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
// Keep the outward error below Slack's long-error withholding threshold. The
// complete stdout/stderr transcript remains available in the restricted log.
const MAX_COMMAND_STREAM_CHARS = 110;
const SETUP_LOG_DIR = join(import.meta.dir, "..", "..", "logs", "worktree-setup");

export interface WorktreeManagerOptions {
  setupMinFreeBytes?: number;
  availableBytes?: (path: string) => Promise<number>;
}

export interface WorktreeStatus {
  tracked: string[];
  untracked: string[];
  unpushedCommits: number;
  unpushedBase: string | null;
}

export class WorktreeManager {
  private repos: RepoConfig[];
  private setupMinFreeBytes: number;
  private availableBytes: (path: string) => Promise<number>;

  constructor(repos: RepoConfig[], options: WorktreeManagerOptions = {}) {
    this.repos = repos;
    const configuredMinimum = options.setupMinFreeBytes ?? Number(
      process.env.WORKTREE_SETUP_MIN_FREE_BYTES ?? DEFAULT_SETUP_MIN_FREE_BYTES,
    );
    this.setupMinFreeBytes = Number.isFinite(configuredMinimum) && configuredMinimum >= 0
      ? configuredMinimum
      : DEFAULT_SETUP_MIN_FREE_BYTES;
    this.availableBytes = options.availableBytes ?? (async (path) => {
      const stats = await statfs(path);
      return stats.bavail * stats.bsize;
    });
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
      await this.assertSetupDiskCapacity(repo.path);
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
      try {
        await this.runCommand(args, repo.path);
      } catch (err) {
        const rollbackError = await this.rollbackFailedSetup(
          repo.path,
          worktreePath,
          branchName,
        );
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          rollbackError
            ? `${message}\nworktree rollback also failed: ${rollbackError}`
            : message,
          { cause: err },
        );
      }
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

  async getWorktreeStatus(
    worktreePath: string,
    repoName?: string,
  ): Promise<WorktreeStatus> {
    const output = await this.runGit(["status", "--porcelain"], worktreePath);
    const status: WorktreeStatus = {
      tracked: [],
      untracked: [],
      ...(await this.getUnpushedStatus(worktreePath, repoName)),
    };
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

  private async getUnpushedStatus(
    worktreePath: string,
    repoName?: string,
  ): Promise<Pick<WorktreeStatus, "unpushedCommits" | "unpushedBase">> {
    const upstream = await this.tryRunGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      worktreePath,
    );
    const repo = repoName ? this.getRepo(repoName) : undefined;
    const base = upstream.trim() || repo?.defaultBase || null;
    if (!base) {
      return { unpushedCommits: 0, unpushedBase: null };
    }

    const count = await this.tryRunGit(
      ["rev-list", "--count", `${base}..HEAD`],
      worktreePath,
    );
    return {
      unpushedCommits: Number.parseInt(count.trim() || "0", 10) || 0,
      unpushedBase: base,
    };
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

  private async tryRunGit(args: string[], cwd: string): Promise<string> {
    try {
      return await this.runGit(args, cwd);
    } catch {
      return "";
    }
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
    // Drain both pipes before awaiting exit so a chatty setup script can't
    // fill its stdout buffer and deadlock.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // Setup scripts narrate their progress (fetch, env copy, MCP migration,
      // dependency install) on stdout and leak only incidental warnings to
      // stderr, so stderr alone rarely names the step that actually failed.
      // Persist both streams in full to a per-run file, and keep the TAIL —
      // where the failure lands — in the thrown message rather than the head.
      const transcript =
        `$ ${args.join(" ")}\n(cwd: ${cwd}, exit ${exitCode})\n\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
      const logPath = this.writeCommandLog(args, transcript);
      const bounded = [
        ["stdout", stdout.trim()],
        ["stderr", stderr.trim()],
      ].flatMap(([label, value]) => {
        if (!value) return [];
        const tail = value.length > MAX_COMMAND_STREAM_CHARS
          ? `… ${value.slice(-MAX_COMMAND_STREAM_CHARS)}`
          : value;
        return [`${label}: ${tail}`];
      }).join("\n");
      const pointer = logPath ? ` (full output: ${logPath})` : "";
      const suffix = bounded ? `: ${bounded}` : "";
      throw new Error(`command ${args[0]} failed with exit ${exitCode}${pointer}${suffix}`);
    }
    return stdout;
  }

  /**
   * Write a failed command's full transcript to `logs/worktree-setup/`.
   * Returns the path, or null if it could not be written — logging must never
   * be the reason a worktree setup failure is swallowed.
   */
  private writeCommandLog(args: string[], transcript: string): string | null {
    try {
      mkdirSync(SETUP_LOG_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const label = (args[1] ?? basename(args[0] ?? "command"))
        .replace(/[^a-zA-Z0-9.-]/g, "-")
        .slice(0, 60);
      const path = join(SETUP_LOG_DIR, `${stamp}-${label}.log`);
      writeFileSync(path, transcript, { mode: 0o600 });
      return path;
    } catch {
      return null;
    }
  }

  private async assertSetupDiskCapacity(path: string): Promise<void> {
    const available = await this.availableBytes(path);
    if (available >= this.setupMinFreeBytes) return;
    const availableMiB = Math.floor(available / 1024 / 1024);
    const requiredMiB = Math.ceil(this.setupMinFreeBytes / 1024 / 1024);
    throw new Error(
      `worktree setup refused: ${availableMiB} MiB free, ${requiredMiB} MiB required; free disk space before retrying`,
    );
  }

  private async rollbackFailedSetup(
    repoPath: string,
    worktreePath: string,
    branchName: string,
  ): Promise<string | null> {
    try {
      if (!await this.worktreeExistsAtPath(worktreePath)) return null;
      await this.runGit(["worktree", "remove", worktreePath, "--force"], repoPath);
      await this.tryRunGit(["branch", "-D", branchName], repoPath);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async worktreeExistsAtPath(path: string): Promise<boolean> {
    try {
      return (await this.runGit(["rev-parse", "--is-inside-work-tree"], path)).trim() === "true";
    } catch {
      return false;
    }
  }
}
