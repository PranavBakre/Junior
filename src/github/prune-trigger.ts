import type { ShadowPersistResult } from "./types.ts";

export type MergedPullRequestPruneTarget = {
  owner: string;
  repo: string;
  number: number;
  branch: string;
  headSha: string;
};

export type MergePruneRunResult = { runId: string };

export type MergePruneDispatcherOptions = {
  run: (
    targets: readonly MergedPullRequestPruneTarget[],
  ) => Promise<MergePruneRunResult>;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxAttempts?: number;
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
  onRun?: (
    targets: readonly MergedPullRequestPruneTarget[],
    result: MergePruneRunResult,
  ) => void;
  onError?: (error: unknown) => void;
  onExhausted?: (
    target: MergedPullRequestPruneTarget,
    error: unknown,
  ) => void;
};

const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Collapse newly persisted merge events into the exact PR branches that should
 * prompt a worktree-prune run. A resource can be associated with several
 * pipeline runs, so key by GitHub coordinates rather than association count.
 */
export function mergedPullRequestPruneTargets(
  results: readonly ShadowPersistResult[],
): MergedPullRequestPruneTarget[] {
  const targets = new Map<string, MergedPullRequestPruneTarget>();

  for (const result of results) {
    for (const event of result.events) {
      if (event.type !== "github.pr.merged") continue;
      const branch = event.next.headRefName;
      const headSha = event.next.headRefOid;
      if (!branch || !headSha) continue;

      const target = {
        owner: event.owner,
        repo: event.repo,
        number: event.number,
        branch,
        headSha,
      };
      targets.set(`${target.owner}/${target.repo}#${target.number}`, target);
    }
  }

  return [...targets.values()];
}

/**
 * Serialize merge-triggered prune runs. The workflow itself uses
 * `concurrency: skip`; when another prune already owns the slot, retain the
 * exact targets and retry instead of silently losing the merge event.
 */
export class MergePruneDispatcher {
  private readonly options: MergePruneDispatcherOptions;
  private readonly pending = new Map<string, MergedPullRequestPruneTarget>();
  private readonly failedAttempts = new Map<string, number>();
  private draining = false;
  private retryScheduled = false;

  constructor(options: MergePruneDispatcherOptions) {
    this.options = options;
  }

  enqueue(results: readonly ShadowPersistResult[]): number {
    const targets = mergedPullRequestPruneTargets(results);
    for (const target of targets) this.addPending(target);
    if (targets.length > 0) void this.drain();
    return targets.length;
  }

  private addPending(target: MergedPullRequestPruneTarget): void {
    this.pending.set(targetKey(target), target);
  }

  private async drain(): Promise<void> {
    if (this.draining || this.retryScheduled || this.pending.size === 0) return;
    this.draining = true;
    const targets = [...this.pending.values()];
    this.pending.clear();

    try {
      const result = await this.options.run(targets);
      this.options.onRun?.(targets, result);
      if (!result.runId) {
        for (const target of targets) this.addPending(target);
        this.scheduleRetry();
      } else {
        for (const target of targets) {
          this.failedAttempts.delete(targetKey(target));
        }
      }
    } catch (error) {
      this.options.onError?.(error);
      let highestFailedAttempt = 0;
      for (const target of targets) {
        const key = targetKey(target);
        const failedAttempt = (this.failedAttempts.get(key) ?? 0) + 1;
        highestFailedAttempt = Math.max(highestFailedAttempt, failedAttempt);
        if (failedAttempt < (this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
          this.failedAttempts.set(key, failedAttempt);
          this.addPending(target);
        } else {
          this.failedAttempts.delete(key);
          this.options.onExhausted?.(target, error);
        }
      }
      if (this.pending.size > 0) {
        this.scheduleRetry(highestFailedAttempt);
      }
    } finally {
      this.draining = false;
      if (!this.retryScheduled && this.pending.size > 0) void this.drain();
    }
  }

  private scheduleRetry(failedAttempt = 0): void {
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    const schedule = this.options.scheduleRetry ?? ((callback, delayMs) => {
      setTimeout(callback, delayMs);
    });
    const baseDelay = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const maxDelay = this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const delayMs = Math.min(
      baseDelay * 2 ** Math.max(0, failedAttempt - 1),
      maxDelay,
    );
    schedule(() => {
      this.retryScheduled = false;
      void this.drain();
    }, delayMs);
  }
}

function targetKey(target: MergedPullRequestPruneTarget): string {
  return `${target.owner}/${target.repo}#${target.number}`;
}
