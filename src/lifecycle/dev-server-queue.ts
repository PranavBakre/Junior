/**
 * DevServerQueue — Scope-2b
 *
 * Wraps DevServerManager with a per-repo filesystem lock (proper-lockfile) so
 * concurrent callers are serialized. This is the answer to the RE-ENTRANCY
 * PRECONDITION comment in DevServerManager.ensure() — callers should go through
 * DevServerQueue.acquire() rather than calling ensure() directly.
 *
 * Lock file layout (all under <repo>.junior-worktrees/slack-dev-server/):
 *   .lock            — proper-lockfile's lock directory (created by the library)
 *   .lock.meta.json  — holder metadata: { holderThreadId, holderPid, branch, acquiredAt }
 *   .queue           — NDJSON, one line per waiter: { threadId, branch, enqueuedAt }
 *
 * The .gitignore at that path covers .lock* and .queue* so they don't show as
 * untracked (gitignore written by DevServerManager.bootstrap() — Scope-2a).
 */

// proper-lockfile: lock() returns a release function; unlock() is not needed separately.
import { lock as lockFile } from "proper-lockfile";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.ts";
import type { RepoConfig } from "../config.ts";
import type { DevServerManager, DevServerInfo } from "./dev-server.ts";
import { isPidAlive, isPortHeld } from "./process-utils.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HolderMeta {
  holderThreadId: string;
  holderPid: number;
  branch: string;
  acquiredAt: number;
}

export interface WaiterMeta {
  threadId: string;
  branch: string;
  enqueuedAt: number;
}

export interface QueueDepth {
  holder: HolderMeta | null;
  waiters: WaiterMeta[];
}

export interface AcquireResult {
  /** Call this to release the lock and update metadata. Idempotent. */
  release: () => Promise<void>;
  info: DevServerInfo;
}

// ---------------------------------------------------------------------------
// Default slot timeout: 10 minutes
// ---------------------------------------------------------------------------
const DEFAULT_SLOT_TIMEOUT_MS = 10 * 60 * 1_000;

// ---------------------------------------------------------------------------
// DevServerQueue
// ---------------------------------------------------------------------------

export class DevServerQueue {
  private devServerManager: DevServerManager;
  private repos: RepoConfig[];

  constructor(devServerManager: DevServerManager, repos: RepoConfig[]) {
    this.devServerManager = devServerManager;
    this.repos = repos;
  }

  /**
   * Acquire the per-repo lock, ensure the dev server is running on `branch`,
   * and return a handle with a `release()` function.
   *
   * The lock path is the dev-server worktree directory. `proper-lockfile`
   * creates a `.lock` subdirectory inside it — this means the worktree must
   * already exist (created by bootstrap()).
   *
   * Behaviour:
   *   1. Append `{ threadId, branch, enqueuedAt }` to `.queue` (O_APPEND NDJSON).
   *   2. Call `proper-lockfile.lock()` with stale=slotTimeoutMs. Blocks until acquired.
   *   3. Call `devServerManager.ensure(repoName, branch)`.
   *   4. Write `.lock.meta.json` atomically (tmp + rename).
   *   5. Return `{ release, info }`.
   *
   * `release()`:
   *   - Writes `{ holderThreadId: null, releasedAt }` to `.lock.meta.json`.
   *   - Removes the threadId entry from `.queue`.
   *   - Calls `proper-lockfile.unlock()`.
   */
  async acquire(
    repoName: string,
    branch: string,
    threadId: string,
    slotTimeoutMs = DEFAULT_SLOT_TIMEOUT_MS,
  ): Promise<AcquireResult> {
    const lockDir = this.getLockDir(repoName);

    if (!existsSync(lockDir)) {
      throw new Error(
        `Dev-server worktree for repo=${repoName} does not exist at ${lockDir}. ` +
          `Run bootstrap() first.`,
      );
    }

    // Step 1: append to the waiter queue before acquiring the lock.
    const waiterEntry: WaiterMeta = { threadId, branch, enqueuedAt: Date.now() };
    appendToQueue(lockDir, waiterEntry);

    log.info("dev-server-queue", `enqueued thread=${threadId} repo=${repoName} branch=${branch}`);

    let releaseLockFile: (() => Promise<void>) | null = null;
    let released = false;
    // Captured AFTER ensure() returns so onCompromised knows which dev-server
    // PID this acquire is responsible for cleaning up. See stealStale's
    // doc-comment for the race this guards against.
    let expectedOrphanPid: number | null = null;

    try {
      // Step 2: acquire the filesystem lock. Retries forever with jitter.
      //
      // `onCompromised` fires from inside proper-lockfile's `setTimeout`-driven
      // update loop when our lockfile mtime is no longer ours (i.e. another
      // process took over after deciding our lock was stale). proper-lockfile
      // ignores the return value of this callback — do NOT mark it `async` and
      // do NOT `await` inside it. The default handler is `(err) => { throw err }`,
      // and throwing from a setTimeout callback is an uncatchable uncaught
      // exception that crashes the bot process. We override with a synchronous
      // handler that fire-and-forgets `stealStale` (cleaning the orphan PID we
      // left bound) and marks local state as released so the user-facing
      // release becomes a no-op.
      releaseLockFile = await lockFile(lockDir, {
        stale: slotTimeoutMs,
        retries: { forever: true, minTimeout: 1_000, maxTimeout: 5_000 },
        onCompromised: (err) => {
          log.warn(
            "dev-server-queue",
            `lock compromised thread=${threadId} repo=${repoName}: ${err.message}; running stealStale (expectedOrphanPid=${expectedOrphanPid})`,
          );
          // Fire and forget — proper-lockfile won't await us.
          this.stealStale(repoName, expectedOrphanPid).catch((killErr) => {
            log.warn(
              "dev-server-queue",
              `stealStale after compromise failed repo=${repoName}: ${killErr instanceof Error ? killErr.message : String(killErr)}`,
            );
          });
          released = true;
          try {
            removeFromQueue(lockDir, threadId);
          } catch {
            /* best-effort cleanup */
          }
        },
      });
    } catch (err) {
      // Failed to acquire — remove ourselves from the queue and rethrow.
      removeFromQueue(lockDir, threadId);
      throw err;
    }

    log.info("dev-server-queue", `lock acquired thread=${threadId} repo=${repoName} branch=${branch}`);

    let info: DevServerInfo;
    try {
      // Step 3: bring the dev server up on the requested branch.
      info = await this.devServerManager.ensure(repoName, branch);
      expectedOrphanPid = info.pid;
    } catch (err) {
      // Ensure failed — release the lock before propagating.
      await releaseLockFile();
      removeFromQueue(lockDir, threadId);
      throw err;
    }

    // Step 4: write holder metadata atomically.
    const metaPath = join(lockDir, ".lock.meta.json");
    const tmpPath = join(lockDir, ".lock.meta.json.tmp");
    const meta: HolderMeta = {
      holderThreadId: threadId,
      holderPid: process.pid,
      branch,
      acquiredAt: Date.now(),
    };
    await writeFile(tmpPath, JSON.stringify(meta));
    await rename(tmpPath, metaPath);

    // Step 5: build the release function.
    const release = async (): Promise<void> => {
      if (released) return; // idempotent
      released = true;

      // Mark the lock as released in meta.
      try {
        const releasedMeta = {
          holderThreadId: null,
          branch,
          releasedAt: Date.now(),
        };
        await writeFile(tmpPath, JSON.stringify(releasedMeta));
        await rename(tmpPath, metaPath);
      } catch (err) {
        log.warn(
          "dev-server-queue",
          `failed to update .lock.meta.json on release repo=${repoName}: ${err}`,
        );
      }

      // Remove ourselves from the queue.
      removeFromQueue(lockDir, threadId);

      // Unlock the lockfile.
      try {
        if (releaseLockFile) await releaseLockFile();
      } catch (err) {
        log.warn("dev-server-queue", `unlock failed repo=${repoName}: ${err}`);
      }

      log.info("dev-server-queue", `lock released thread=${threadId} repo=${repoName}`);
    };

    return { release, info };
  }

  /**
   * Read the current queue depth for a repo. Safe to call at any time — reads
   * `.lock.meta.json` and `.queue` from the lock directory.
   *
   * Returns `{ holder: null, waiters: [] }` when the worktree doesn't exist yet.
   */
  async readQueueDepth(repoName: string): Promise<QueueDepth> {
    const lockDir = this.getLockDir(repoName);
    if (!existsSync(lockDir)) {
      return { holder: null, waiters: [] };
    }
    return {
      holder: readHolderMeta(lockDir),
      waiters: readWaiters(lockDir),
    };
  }

  /**
   * Kill any orphan dev-server PID that is holding the port when proper-lockfile
   * detects a stale lock and steals it. The library's auto-steal is blunt — it
   * takes the lock but the previous holder's dev server may still be bound on
   * the port. This helper finds and kills such orphans.
   *
   * `expectedOrphanPid` is the dev-server PID this caller previously spawned
   * and now expects to clean up. The race we guard against:
   *
   *   1. Thread A acquires; ensure() spawns PID X; A's expectedOrphanPid = X.
   *   2. Thread A's lock goes stale (event loop stall, etc.).
   *   3. Thread B steals the lock; B's ensure() kills X and spawns PID Y.
   *   4. Thread A's onCompromised fires from inside its update timer and calls
   *      stealStale. Without the guard, this would kill PID Y — Thread B's
   *      freshly-started server, not an orphan.
   *
   * If the manager's currently-tracked PID for this repo no longer matches the
   * one we expected, a different acquire has already replaced it; bail. If
   * `expectedOrphanPid` is `null`, fall back to the legacy best-effort kill
   * (used by direct callers that don't have a captured PID — e.g. boot-time
   * orphan recovery).
   */
  async stealStale(
    repoName: string,
    expectedOrphanPid: number | null = null,
  ): Promise<void> {
    const repo = this.repos.find((r) => r.name === repoName);
    if (!repo?.devPort) return;

    const held = await isPortHeld(repo.devPort);
    if (!held) return;

    if (expectedOrphanPid !== null) {
      const tracked = this.devServerManager.status(repoName) as
        | { pid: number | null }
        | undefined;
      const trackedPid = tracked?.pid ?? null;
      if (trackedPid !== null && trackedPid !== expectedOrphanPid) {
        log.info(
          "dev-server-queue",
          `stealStale repo=${repoName}: tracked pid=${trackedPid} != expected=${expectedOrphanPid}; another acquire already replaced the server, skipping kill`,
        );
        return;
      }
    }

    // Check if the PID in the meta matches any alive process listening on the port.
    // If meta is stale (different pid or null), kill the process on the port.
    const lockDir = this.getLockDir(repoName);
    const meta = readHolderMeta(lockDir);

    if (meta?.holderPid && isPidAlive(meta.holderPid)) {
      log.warn(
        "dev-server-queue",
        `stealStale repo=${repoName}: port ${repo.devPort} held by pid=${meta.holderPid} which is still alive; deferring to DevServerManager.kill()`,
      );
      await this.devServerManager.kill(repoName);
    } else {
      log.warn(
        "dev-server-queue",
        `stealStale repo=${repoName}: port ${repo.devPort} held by orphan; killing via DevServerManager`,
      );
      await this.devServerManager.kill(repoName);
    }
  }

  /**
   * Public passthrough to `DevServerManager.kill`, used by the `!devserver kill`
   * directive. Keeps the directive handler from having to cast through a private
   * field on the queue.
   */
  async kill(repoName: string): Promise<void> {
    await this.devServerManager.kill(repoName);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the lock directory path for a repo.
   * This is the dev-server worktree: <repo.path>.junior-worktrees/slack-dev-server
   * Path shape mirrors WorktreeManager.getWorktreePath — keep them in sync.
   */
  private getLockDir(repoName: string): string {
    const repo = this.repos.find((r) => r.name === repoName);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoName}`);
    }
    // Strip trailing slashes — see WorktreeManager.getWorktreePath for why.
    const base = repo.path.replace(/\/+$/, "");
    return `${base}.junior-worktrees/slack-dev-server`;
  }
}

// ---------------------------------------------------------------------------
// File-level helpers (exported for use by the !devserver handler in router.ts)
// ---------------------------------------------------------------------------

/**
 * Append a waiter entry to the `.queue` NDJSON file.
 * Uses synchronous write with O_APPEND so concurrent writers don't corrupt
 * each other (the kernel serializes O_APPEND writes on POSIX).
 */
export function appendToQueue(lockDir: string, entry: WaiterMeta): void {
  const queuePath = join(lockDir, ".queue");
  const line = JSON.stringify(entry) + "\n";
  try {
    writeFileSync(queuePath, line, { flag: "a" });
  } catch (err) {
    log.warn("dev-server-queue", `appendToQueue failed: ${err}`);
  }
}

/**
 * Remove a threadId's entry from the `.queue` file.
 * Rewrites the file atomically by filtering out the matching line.
 */
export function removeFromQueue(lockDir: string, threadId: string): void {
  const queuePath = join(lockDir, ".queue");
  if (!existsSync(queuePath)) return;
  try {
    const content = readFileSync(queuePath, "utf8");
    const remaining = content
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          const parsed = JSON.parse(line) as WaiterMeta;
          return parsed.threadId !== threadId;
        } catch {
          return true; // keep malformed lines
        }
      })
      .join("\n");
    writeFileSync(queuePath, remaining ? remaining + "\n" : "");
  } catch (err) {
    log.warn("dev-server-queue", `removeFromQueue failed: ${err}`);
  }
}

/**
 * Read the current waiter list from the `.queue` file.
 */
export function readWaiters(lockDir: string): WaiterMeta[] {
  const queuePath = join(lockDir, ".queue");
  if (!existsSync(queuePath)) return [];
  try {
    const content = readFileSync(queuePath, "utf8");
    const result: WaiterMeta[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        result.push(JSON.parse(line) as WaiterMeta);
      } catch {
        // skip malformed lines
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Read the holder metadata from `.lock.meta.json`. Returns null if absent or
 * unparseable.
 */
export function readHolderMeta(lockDir: string): HolderMeta | null {
  const metaPath = join(lockDir, ".lock.meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    const content = readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(content) as HolderMeta | { holderThreadId: null };
    // If it was written by release(), holderThreadId is null — not a real holder.
    if (!parsed.holderThreadId) return null;
    return parsed as HolderMeta;
  } catch {
    return null;
  }
}

/**
 * Ensure the lockDir exists. Creates it recursively if needed.
 * Idempotent.
 */
export function ensureLockDir(lockDir: string): void {
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }
}

