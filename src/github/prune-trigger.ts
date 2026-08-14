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
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
  onRun?: (
    targets: readonly MergedPullRequestPruneTarget[],
    result: MergePruneRunResult,
  ) => void;
  onError?: (error: unknown) => void;
};

const DEFAULT_RETRY_DELAY_MS = 30_000;

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
    this.pending.set(`${target.owner}/${target.repo}#${target.number}`, target);
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
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.draining = false;
      if (!this.retryScheduled && this.pending.size > 0) void this.drain();
    }
  }

  private scheduleRetry(): void {
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    const schedule = this.options.scheduleRetry ?? ((callback, delayMs) => {
      setTimeout(callback, delayMs);
    });
    schedule(() => {
      this.retryScheduled = false;
      void this.drain();
    }, this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }
}
