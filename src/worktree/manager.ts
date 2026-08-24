import type { RepoConfig } from "../config.ts";
import { cleanGitHubEnvironment, GitHubAuthResolver } from "../github/auth.ts";
import { statfs } from "node:fs/promises";
import {
  closeSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { terminateProcessTree } from "../lifecycle/process-tree.ts";
import { ignoredDotenvPaths } from "./safety.ts";

const DEFAULT_SETUP_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_SETUP_COMMAND_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
// Keep the outward error below Slack's long-error withholding threshold. The
// complete stdout/stderr transcript remains available in the restricted log.
const MAX_COMMAND_STREAM_CHARS = 110;
const MAX_GIT_STREAM_CHARS = 64 * 1024;
const SETUP_LOG_DIR = join(import.meta.dir, "..", "..", "logs", "worktree-setup");

export interface WorktreeManagerOptions {
  setupMinFreeBytes?: number;
  availableBytes?: (path: string) => Promise<number>;
  githubAuth?: GitHubAuthResolver;
  /** Hard bound for local git operations. Defaults to 30 seconds. */
  gitCommandTimeoutMs?: number;
  /** Hard bound for delegated repo setup scripts. Defaults to 15 minutes. */
  setupCommandTimeoutMs?: number;
  /** Grace period before a timed-out process group is force-killed. */
  terminationGraceMs?: number;
}

export interface WorktreeStatus {
  tracked: string[];
  untracked: string[];
  /** Ignored dotenv paths are enumerated without reading their contents. */
  ignoredDotenv: string[];
  unpushedCommits: number;
  unpushedBase: string | null;
}

export class WorktreeManager {
  private repos: RepoConfig[];
  private setupMinFreeBytes: number;
  private availableBytes: (path: string) => Promise<number>;
  private githubAuth: GitHubAuthResolver;
  private gitCommandTimeoutMs: number;
  private setupCommandTimeoutMs: number;
  private terminationGraceMs: number;

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
    this.githubAuth = options.githubAuth ?? new GitHubAuthResolver(repos);
    this.gitCommandTimeoutMs = this.resolveTimeout(
      options.gitCommandTimeoutMs,
      "WORKTREE_GIT_TIMEOUT_MS",
      DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    );
    this.setupCommandTimeoutMs = this.resolveTimeout(
      options.setupCommandTimeoutMs,
      "WORKTREE_SETUP_TIMEOUT_MS",
      DEFAULT_SETUP_COMMAND_TIMEOUT_MS,
    );
    this.terminationGraceMs = this.resolveTimeout(
      options.terminationGraceMs,
      "WORKTREE_TERMINATION_GRACE_MS",
      DEFAULT_TERMINATION_GRACE_MS,
    );
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
    const githubEnv = await this.githubEnvironment(repo);

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
        await this.runCommand(args, repo.path, githubEnv);
      } catch (err) {
        const rollbackError = await this.rollbackFailedSetup(
          repo.path,
          worktreePath,
          branchName,
          githubEnv,
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
      await this.runGit(["fetch", "origin", "--prune"], repo.path, githubEnv);
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
   * Refresh remote refs from the configured repository checkout.
   *
   * Managed worktrees share Git metadata with that checkout. Sandboxed
   * providers intentionally cannot write the shared `.git` directory, so the
   * server owns the pre-turn fetch and workers consume refreshed origin refs.
   */
  async syncRepo(repoName: string): Promise<void> {
    const repo = this.getRepo(repoName);
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);
    await this.runGit(
      ["fetch", "origin", "--prune"],
      repo.path,
      await this.githubEnvironment(repo),
    );
  }

  /** Return the selected repo-scoped GitHub environment for runner children. */
  async getGitHubEnvironment(
    repoName: string,
  ): Promise<Record<string, string> | undefined> {
    const repo = this.getRepo(repoName);
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);
    return this.githubEnvironment(repo);
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
    const ignored = await this.runGit(
      [
        "ls-files", "--others", "--ignored", "--exclude-standard", "--",
        ".env", ":(glob)**/.env", ":(glob)**/.env.*",
      ],
      worktreePath,
    );
    const status: WorktreeStatus = {
      tracked: [],
      untracked: [],
      ignoredDotenv: ignoredDotenvPaths(ignored),
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
  private async runGit(
    args: string[],
    cwd: string,
    githubEnv?: Record<string, string>,
  ): Promise<string> {
    const result = await this.runBoundedCommand(
      ["git", "--no-pager", "-c", "credential.helper=", ...args],
      cwd,
      githubEnv,
      this.gitCommandTimeoutMs,
      MAX_GIT_STREAM_CHARS,
    );
    if (result.timedOut) {
      throw new Error(`git ${args[0]} timed out after ${this.gitCommandTimeoutMs}ms`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  private async tryRunGit(
    args: string[],
    cwd: string,
    githubEnv?: Record<string, string>,
  ): Promise<string> {
    try {
      return await this.runGit(args, cwd, githubEnv);
    } catch {
      return "";
    }
  }

  /**
   * Run an arbitrary command (e.g. a worktreeSetupCommand script) in `cwd`.
   * The first element is the command; remaining elements are args.
   * Throws on non-zero exit.
   */
  private async runCommand(
    args: string[],
    cwd: string,
    githubEnv?: Record<string, string>,
  ): Promise<void> {
    // Stream both pipes concurrently. Keeping only bounded tails prevents a
    // runaway installer from either filling an OS pipe or filling Junior's
    // heap; the complete output is written incrementally to a restricted log.
    const commandLog = this.openCommandLog(args, cwd);
    let stdout = "";
    let stderr = "";
    try {
      const result = await this.runBoundedCommand(
        args,
        cwd,
        githubEnv,
        this.setupCommandTimeoutMs,
        MAX_COMMAND_STREAM_CHARS,
        commandLog?.fd ?? null,
      );
      stdout = result.stdout;
      stderr = result.stderr;
      if (result.timedOut) {
        const pointer = commandLog ? ` (full output: ${commandLog.path})` : "";
        throw new Error(`command ${args[0]} timed out after ${this.setupCommandTimeoutMs}ms${pointer}`);
      }
      if (result.exitCode !== 0) {
        const bounded = [
          ["stdout", stdout],
          ["stderr", stderr],
        ].flatMap(([label, value]) => {
          if (!value) return [];
          return [`${label}: ${value}`];
        }).join("\n");
        const pointer = commandLog ? ` (full output: ${commandLog.path})` : "";
        const suffix = bounded ? `: ${bounded}` : "";
        throw new Error(`command ${args[0]} failed with exit ${result.exitCode}${pointer}${suffix}`);
      }
    } finally {
      if (commandLog) {
        try {
          closeSync(commandLog.fd);
        } catch {
          // The process result remains authoritative if transcript close fails.
        }
      }
    }
    if (commandLog) {
      try {
        unlinkSync(commandLog.path);
      } catch {
        // A successful setup must not fail because its temporary transcript
        // could not be removed.
      }
    }
  }

  private openCommandLog(
    args: string[],
    cwd: string,
  ): { path: string; fd: number } | null {
    try {
      mkdirSync(SETUP_LOG_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const label = (args[1] ?? basename(args[0] ?? "command"))
        .replace(/[^a-zA-Z0-9.-]/g, "-")
        .slice(0, 60);
      const path = join(SETUP_LOG_DIR, `${stamp}-${label}.log`);
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `$ ${args.join(" ")}\n(cwd: ${cwd})\n`);
      return { path, fd };
    } catch {
      return null;
    }
  }

  private startOutputDrain(
    stream: ReadableStream<Uint8Array>,
    label: "stdout" | "stderr",
    maxChars: number,
    logFd: number | null,
  ): { done: Promise<void>; tail: () => string; cancel: () => void } {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let tail = "";
    const consume = (text: string): void => {
      if (!text) return;
      tail = `${tail}${text}`.slice(-maxChars);
      if (logFd !== null) {
        try {
          writeSync(logFd, text);
        } catch {
          // Keep draining even when the diagnostic filesystem is unavailable.
        }
      }
    };
    if (logFd !== null) {
      try {
        writeSync(logFd, `\n--- ${label} ---\n`);
      } catch {
        // Keep draining without a transcript.
      }
    }
    const done = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          consume(decoder.decode(value, { stream: true }));
        }
        consume(decoder.decode());
      } catch {
        // A hard timeout cancels the reader after terminating its process group.
        // The partial bounded tail is still useful in the surfaced error.
      }
    })();
    return {
      done,
      tail: () => tail.trim(),
      cancel: () => { void reader.cancel().catch(() => undefined); },
    };
  }

  /**
   * Run all worktree subprocesses in a dedicated process group with a hard
   * wall-clock bound. Waiting for `exited` alone is unsafe: a setup wrapper can
   * leave a grandchild holding stdout/stderr open after the wrapper exits.
   */
  private async runBoundedCommand(
    args: string[],
    cwd: string,
    githubEnv: Record<string, string> | undefined,
    timeoutMs: number,
    maxStreamChars: number,
    logFd: number | null = null,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const proc = Bun.spawn(args, {
      cwd,
      env: this.commandEnvironment(githubEnv),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const stdout = this.startOutputDrain(proc.stdout, "stdout", maxStreamChars, logFd);
    const stderr = this.startOutputDrain(proc.stderr, "stderr", maxStreamChars, logFd);
    const completed = Promise.all([proc.exited, stdout.done, stderr.done]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([completed, timeout]);
      if (outcome === "timeout") {
        await terminateProcessTree(proc.pid, {
          signal: "SIGTERM",
          forceAfterMs: this.terminationGraceMs,
          waitAfterForceMs: this.terminationGraceMs,
        });
        stdout.cancel();
        stderr.cancel();
        return { exitCode: null, stdout: stdout.tail(), stderr: stderr.tail(), timedOut: true };
      }
      return {
        exitCode: outcome[0],
        stdout: stdout.tail(),
        stderr: stderr.tail(),
        timedOut: false,
      };
    } finally {
      clearTimeout(timer);
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
    githubEnv?: Record<string, string>,
  ): Promise<string | null> {
    try {
      if (!await this.worktreeExistsAtPath(worktreePath)) return null;
      await this.runGit(
        ["worktree", "remove", worktreePath, "--force"],
        repoPath,
        githubEnv,
      );
      await this.tryRunGit(["branch", "-D", branchName], repoPath, githubEnv);
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

  private async githubEnvironment(
    repo: RepoConfig,
  ): Promise<Record<string, string> | undefined> {
    return this.githubAuth.environmentForRepo(repo);
  }

  private commandEnvironment(
    githubEnv?: Record<string, string>,
  ): Record<string, string> {
    const env = {
      ...cleanGitHubEnvironment({ isolatedConfig: true }),
      ...githubEnv,
    };
    // Git's prompt paths can outlive a child process (credential helpers and
    // SSH read /dev/tty directly), so every inline Git command and delegated
    // setup script receives a fail-fast, noninteractive transport contract.
    // The injected empty credential.helper resets any inherited helper list.
    const configuredSsh = env.GIT_SSH_COMMAND?.trim() || "ssh";
    return {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GCM_INTERACTIVE: "Never",
      GIT_SSH_COMMAND: `${configuredSsh} -oBatchMode=yes -oNumberOfPasswordPrompts=0 -oConnectTimeout=10`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
    };
  }

  private resolveTimeout(
    override: number | undefined,
    envName: string,
    fallback: number,
  ): number {
    const candidate = override ?? Number(process.env[envName] ?? fallback);
    return Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
  }
}
