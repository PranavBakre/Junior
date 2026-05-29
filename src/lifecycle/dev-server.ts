/**
 * DevServerManager — Scope-2a
 *
 * Junior owns the lifecycle of dev servers that are used for bug-pipeline
 * validation. Each repo with `devCommand` configured gets a single shared
 * dev-server process running from a dedicated worktree at
 * `<repo>.junior-worktrees/slack-dev-server` (sibling to the repo, NOT under
 * `.claude/` — see WorktreeManager.getWorktreePath for why).
 *
 * Scope-2b will layer the per-repo lock/queue on top; this module only handles
 * spawn / probe / kill / idle-TTL.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { log } from "../logger.ts";
import type { RepoConfig } from "../config.ts";
import { WorktreeManager } from "../worktree/manager.ts";
import { isPidAlive, isPortHeld } from "./process-utils.ts";
import { isProcessTreeAlive, terminateProcessTree } from "./process-tree.ts";

export interface DevServerState {
  pid: number | null;
  branch: string | null;
  startedAt: number;
  lastUsedAt: number;
}

export interface DevServerInfo {
  pid: number;
  port: number;
  readyUrl: string;
}

/** Fixed thread-ID used for the per-repo dev-server worktree. */
const DEV_SERVER_THREAD_ID = "dev-server";

/** How long to poll readyUrl before giving up (ms). */
const READY_TIMEOUT_MS = 90_000;

/** How long between readiness poll attempts (ms). */
const READY_POLL_INTERVAL_MS = 1_000;

/** Idle TTL — kill dev server after this many ms with no `ensure()` call. */
const IDLE_TTL_MS = 20 * 60 * 1_000;

/** How often to check for idle servers (ms). */
const IDLE_SWEEP_INTERVAL_MS = 60_000;

/** Grace period for SIGINT before escalating to SIGKILL (ms). */
const SIGINT_GRACE_MS = 5_000;

/** After a kill, wait briefly for the listener to release its TCP port. */
const PORT_RELEASE_TIMEOUT_MS = 5_000;

export interface DevServerManagerOptions {
  /** Override the 20-min idle TTL. Tests use this to drive the sweeper. */
  idleTtlMs?: number;
  /** Override the 60s sweep interval. Tests use this to drive the sweeper. */
  sweepIntervalMs?: number;
}

export class DevServerManager {
  private repos: RepoConfig[];
  private worktreeManager: WorktreeManager;
  private state = new Map<string, DevServerState>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private idleTtlMs: number;
  private sweepIntervalMs: number;

  constructor(
    repos: RepoConfig[],
    worktreeManager?: WorktreeManager,
    opts: DevServerManagerOptions = {},
  ) {
    this.repos = repos;
    // Allow callers to inject a WorktreeManager (tests do this). When running
    // in production the manager is always passed from index.ts.
    this.worktreeManager = worktreeManager ?? new WorktreeManager(repos);
    this.idleTtlMs = opts.idleTtlMs ?? IDLE_TTL_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS;
    this.startIdleTtlSweeper();
  }

  /**
   * Run the idle-TTL sweep synchronously, once. Test hook so the
   * detection logic in the sweeper body is exercisable without driving
   * a 1-minute interval timer. Returns the names of repos whose dev
   * servers were killed by this sweep.
   */
  async sweepNow(): Promise<string[]> {
    const now = Date.now();
    const killed: string[] = [];
    for (const [repoName, s] of this.state) {
      if (s.pid != null && now - s.lastUsedAt > this.idleTtlMs) {
        killed.push(repoName);
        await this.kill(repoName);
      }
    }
    return killed;
  }

  /**
   * Ensure the dev server for `repoName` is running on `branch`.
   *
   * - If no server is tracked, or the tracked branch differs, kill the current
   *   process (if any) and start a fresh one.
   * - If the server is already running on the correct branch (and the PID is
   *   alive), bump `lastUsedAt` and return immediately.
   *
   * **RE-ENTRANCY PRECONDITION** — callers must serialize `ensure()` per repo.
   * Two concurrent `ensure(repo, branch)` calls both miss the reuse branch,
   * both run `git reset --hard`, and both call `Bun.spawn`. The second
   * `state.set` orphans the first PID — it stays bound to the port forever
   * with no in-memory handle to kill.
   *
   * **This is now satisfied by `DevServerQueue.acquire()` (Scope-2b).**
   * `acquire()` calls `proper-lockfile.lock()` before calling `ensure()`,
   * serializing concurrent callers at the filesystem level. All production
   * callers should go through `DevServerQueue.acquire()`, NOT call `ensure()`
   * directly. If you add a direct caller, you MUST add per-repo serialization
   * at the call site (an in-memory `Map<repoName, Promise<DevServerInfo>>` of
   * in-flight calls would be the minimal fix). Do not assume callers are
   * single-threaded just because nothing visibly races today.
   */
  async ensure(repoName: string, branch: string): Promise<DevServerInfo> {
    const repo = this.getRepoOrThrow(repoName);
    this.assertDevConfigured(repo);

    const current = this.state.get(repoName);

    if (current?.pid != null && current.branch === branch) {
      if (isPidAlive(current.pid)) {
        log.info("dev-server", `reuse repo=${repoName} branch=${branch} pid=${current.pid}`);
        current.lastUsedAt = Date.now();
        return this.makeInfo(repo, current.pid);
      }
      // PID is dead — fall through to restart
      log.warn("dev-server", `tracked pid=${current.pid} for repo=${repoName} is dead; restarting`);
    }

    // Kill whatever is running (if anything) before switching branches.
    await this.kill(repoName);

    const worktreePath = this.worktreeManager.getWorktreePath(repoName, DEV_SERVER_THREAD_ID);

    // Switch the dev-server worktree to the requested branch.
    // We use `fetch + reset --hard origin/<branch>` rather than `git checkout`
    // because `git checkout <branch>` fails when that branch is already checked
    // out in another worktree (e.g. the bare repo on `main`). `reset --hard`
    // moves the worktree's HEAD to the remote ref without touching branches in
    // other worktrees. FETCH_HEAD is also tried as a fallback for local-only
    // branches that have no upstream.
    log.info("dev-server", `checkout repo=${repoName} branch=${branch} at ${worktreePath}`);
    await runGit(["fetch", "origin"], worktreePath);
    // Try to reset to the remote tracking branch. Fall back to local ref.
    try {
      await runGit(["reset", "--hard", `origin/${branch}`], worktreePath);
    } catch {
      // No upstream — try local ref (e.g. for branches only pushed as local).
      await runGit(["reset", "--hard", branch], worktreePath);
    }

    // Spawn the dev server.
    const cmdParts = (repo.devCommand as string).trim().split(/\s+/);
    log.info("dev-server", `spawn repo=${repoName} cmd=${cmdParts.join(" ")} cwd=${worktreePath}`);
    const proc = Bun.spawn(cmdParts, {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      // Don't inherit stdin — we don't want the process to block on stdin.
    });

    const pid = proc.pid;
    const now = Date.now();
    this.state.set(repoName, { pid, branch, startedAt: now, lastUsedAt: now });

    // Poll readyUrl until HTTP 200 or timeout.
    const readyUrl = resolveReadyUrl(repo);
    await this.waitForReady(repoName, readyUrl, pid, proc);

    log.info("dev-server", `ready repo=${repoName} branch=${branch} pid=${pid} url=${readyUrl}`);
    return this.makeInfo(repo, pid);
  }

  /**
   * Kill the dev server for `repoName`. Idempotent — no-op if nothing is
   * tracked or the process is already dead.
   */
  async kill(repoName: string): Promise<void> {
    const current = this.state.get(repoName);
    if (!current?.pid) {
      this.state.delete(repoName);
      return;
    }
    const pid = current.pid;
    // Clear state immediately so concurrent calls are idempotent.
    this.state.delete(repoName);

    if (!isProcessTreeAlive(pid)) {
      log.info("dev-server", `kill repo=${repoName} pid=${pid} already dead`);
      await this.waitForPortRelease(repoName);
      return;
    }

    log.info("dev-server", `kill repo=${repoName} pid=${pid} SIGINT tree`);
    await terminateProcessTree(pid, { signal: "SIGINT", forceAfterMs: SIGINT_GRACE_MS });
    if (isProcessTreeAlive(pid)) {
      log.warn("dev-server", `kill repo=${repoName} pid=${pid} tree still alive after SIGKILL`);
    } else {
      log.info("dev-server", `kill repo=${repoName} pid=${pid} tree exited`);
    }
    await this.waitForPortRelease(repoName);
  }

  /** Kill all tracked dev servers in parallel. Called during shutdown. */
  async killAll(): Promise<void> {
    const names = [...this.state.keys()];
    await Promise.all(names.map((name) => this.kill(name)));
  }

  /** Return current state for diagnostics. Pass repoName to scope. */
  status(repoName?: string): Map<string, DevServerState> | DevServerState | undefined {
    if (repoName !== undefined) {
      return this.state.get(repoName);
    }
    return new Map(this.state);
  }

  /** Configured idle TTL in ms. Surfaced for diagnostics (HTTP dashboard). */
  getIdleTtlMs(): number {
    return this.idleTtlMs;
  }

  /**
   * Bootstrap step: run once at junior startup.
   *
   * For each repo with `devCommand` configured:
   *   1. Ensure the dev-server worktree exists (create via WorktreeManager if not).
   *   2. Check if the configured port already has a listener that junior didn't
   *      spawn. If so, refuse to spawn and log loudly.
   */
  async bootstrap(): Promise<void> {
    for (const repo of this.repos) {
      if (!repo.devCommand) continue;

      // Step 1: ensure the dev-server worktree exists.
      const exists = await this.worktreeManager.worktreeExists(repo.name, DEV_SERVER_THREAD_ID);
      if (!exists) {
        log.info("dev-server", `bootstrap: creating dev-server worktree for repo=${repo.name}`);
        try {
          await this.worktreeManager.createWorktree(
            repo.name,
            DEV_SERVER_THREAD_ID,
            repo.defaultBase,
            `dev-server-slot/${repo.name}`,
          );
          log.info("dev-server", `bootstrap: worktree created for repo=${repo.name}`);
        } catch (err) {
          log.error(
            "dev-server",
            `bootstrap: failed to create worktree for repo=${repo.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Non-fatal: dev-server usage will fail gracefully at ensure() time.
        }
      }

      // Hide the queue's lock/state files from `git status` in the dev-server
      // worktree. We write to the worktree's per-clone `info/exclude` rather
      // than `.gitignore` — these are operational artifacts, not source-tree
      // ignores. Writing to `.gitignore` would clobber the upstream-tracked
      // file (it's shared-owner: upstream repo + user + tools all contribute).
      // `info/exclude` is per-worktree (lives in `<main>/.git/worktrees/<name>/info/exclude`)
      // and untracked, so this write is idempotent and invisible to git status.
      const wtPath = this.worktreeManager.getWorktreePath(repo.name, DEV_SERVER_THREAD_ID);
      try {
        const rawGitDir = (await runGit(["rev-parse", "--git-dir"], wtPath)).trim();
        const gitDir = isAbsolute(rawGitDir) ? rawGitDir : join(wtPath, rawGitDir);
        const infoDir = join(gitDir, "info");
        mkdirSync(infoDir, { recursive: true });
        writeFileSync(join(infoDir, "exclude"), ".lock*\n.queue*\n");
      } catch (err) {
        log.warn(
          "dev-server",
          `bootstrap: failed to write info/exclude for repo=${repo.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Self-heal: a previous version of bootstrap (before this fix) wrote
      // ".lock*\n.queue*\n" into .gitignore directly, clobbering the
      // upstream-tracked file. Detect that exact fingerprint and restore.
      // Exact-match only — zero risk of overwriting legitimate edits.
      // Separate try-block so failure here doesn't mask info/exclude success.
      try {
        const gitignorePath = join(wtPath, ".gitignore");
        if (existsSync(gitignorePath)) {
          const content = readFileSync(gitignorePath, "utf8");
          if (content === ".lock*\n.queue*\n") {
            log.info(
              "dev-server",
              `bootstrap: detected legacy .gitignore overwrite in repo=${repo.name}, restoring upstream`,
            );
            // Remove the corrupt file, then ask git to restore from HEAD.
            // If upstream doesn't track .gitignore, the unlink alone is the
            // correct cleanup and the restore will fail harmlessly.
            unlinkSync(gitignorePath);
            try {
              await runGit(["checkout", "--", ".gitignore"], wtPath);
            } catch {
              // Upstream doesn't track .gitignore; unlink is sufficient.
            }
          }
        }
      } catch (err) {
        log.warn(
          "dev-server",
          `bootstrap: failed to self-heal .gitignore for repo=${repo.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Step 2: scan the configured port for external listeners.
      if (repo.devPort != null) {
        const held = await isPortHeld(repo.devPort);
        if (held) {
          log.error(
            "dev-server",
            `[dev-server] port ${repo.devPort} for ${repo.name} is held by something junior didn't spawn; skipping bootstrap.`,
          );
          // We intentionally do NOT kill it — it might be the human developer's
          // own server. Scope-2b's lock acquire path will handle the conflict at
          // validation time.
        }
      }
    }
  }

  /** Tear down the sweeper timer. Call this when the process exits (for tests). */
  dispose(): void {
    if (this.sweepTimer != null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private startIdleTtlSweeper(): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [repoName, s] of this.state) {
        if (s.pid != null && now - s.lastUsedAt > this.idleTtlMs) {
          log.info("dev-server", `idle TTL expired for repo=${repoName}; killing`);
          this.kill(repoName).catch((err) => {
            log.error("dev-server", `idle kill failed for repo=${repoName}: ${err}`);
          });
        }
      }
    }, this.sweepIntervalMs);

    // Don't block process exit on the sweeper.
    if (this.sweepTimer.unref) {
      this.sweepTimer.unref();
    }
  }

  private async waitForReady(
    repoName: string,
    readyUrl: string,
    expectedPid: number,
    _proc: ReturnType<typeof Bun.spawn>,
  ): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastErr = "";

    while (Date.now() < deadline) {
      // Bail if the PID died before becoming ready.
      if (!isPidAlive(expectedPid)) {
        throw new Error(
          `dev server for ${repoName} exited before becoming ready (url=${readyUrl})`,
        );
      }

      try {
        const res = await fetch(readyUrl, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }

      await sleep(READY_POLL_INTERVAL_MS);
    }

    // Timed out — kill the orphan and throw.
    await this.kill(repoName);
    throw new Error(
      `dev server for ${repoName} did not become ready within ${READY_TIMEOUT_MS / 1000}s (url=${readyUrl}, last error: ${lastErr})`,
    );
  }

  private async waitForPortRelease(repoName: string): Promise<void> {
    const repo = this.repos.find((r) => r.name === repoName);
    if (repo?.devPort == null) return;

    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await isPortHeld(repo.devPort))) return;
      await sleep(100);
    }

    log.warn(
      "dev-server",
      `port ${repo.devPort} for ${repoName} is still held after killing dev server`,
    );
  }

  private getRepoOrThrow(repoName: string): RepoConfig {
    const repo = this.repos.find((r) => r.name === repoName);
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);
    return repo;
  }

  private assertDevConfigured(repo: RepoConfig): void {
    if (!repo.devCommand) {
      throw new Error(`No devCommand configured for repo ${repo.name}`);
    }
    if (!repo.devPort && !repo.readyUrl) {
      throw new Error(
        `Repo ${repo.name} has devCommand but neither devPort nor readyUrl is set; cannot probe readiness`,
      );
    }
  }

  private makeInfo(repo: RepoConfig, pid: number): DevServerInfo {
    const port = repo.devPort ?? 0;
    const readyUrl = resolveReadyUrl(repo);
    return { pid, port, readyUrl };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (no class dependency)
// ---------------------------------------------------------------------------

export function resolveReadyUrl(repo: RepoConfig): string {
  if (repo.readyUrl) return repo.readyUrl;
  return `http://localhost:${repo.devPort}`;
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a git command in `cwd`. Throws on non-zero exit. */
async function runGit(args: string[], cwd: string): Promise<string> {
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
