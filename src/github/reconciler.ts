/**
 * GitHub reconciler — poll tracked PR resources, persist snapshots and typed
 * semantic events. Phase 5 shadow mode never wakes agents. Phase 6 enables
 * wake delivery when eventWakeEnabled=true and shadowMode=false: the bug
 * controller reduces persisted events into exact assignment wakes.
 */

import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import type { GitHubClient } from "./client.ts";
import {
  diffPrSnapshots,
  proposeReductionsForEvents,
} from "./diff.ts";
import type {
  GitHubPollClass,
  GitHubResource,
  PipelineGitHubResource,
  PrSnapshot,
  ProposedReduction,
  ShadowPersistResult,
} from "./types.ts";
import {
  GITHUB_BACKOFF_CEILING_MS,
  GITHUB_POLL_HOT_MS,
  GITHUB_POLL_WARM_MS,
} from "./types.ts";

/** Store surface the reconciler needs (subset of PipelineStore). */
export interface GitHubReconcileStore {
  listDueGitHubResources(now: number, limit?: number): Promise<GitHubResource[]>;
  listActiveTrackedResources(): Promise<GitHubResource[]>;
  listAssociationsForResource(
    resourceId: string,
    activeOnly?: boolean,
  ): Promise<PipelineGitHubResource[]>;
  claimGitHubResourceLease(
    id: string,
    owner: string,
    leaseMs: number,
    now?: number,
  ): Promise<boolean>;
  releaseGitHubResourceLease(id: string): Promise<void>;
  applyGitHubSnapshotShadow(input: {
    resourceId: string;
    snapshot: PrSnapshot;
    nodeId?: string | null;
    events: import("./types.ts").GitHubSemanticEvent[];
    proposedReductions: ProposedReduction[];
    nextPollAt: number;
    pollClass?: GitHubPollClass;
    terminalAt?: number | null;
    /** Controller owns wake delivery; store always persists as shadow. */
    wakeEnabled?: boolean;
  }): Promise<ShadowPersistResult>;
  recordGitHubPollFailure(
    resourceId: string,
    error: string,
    nextPollAt: number,
  ): Promise<void>;
  /**
   * Optional: mark credentials invalid so the poller stops hammering GitHub.
   * Implementations may no-op; reconciler tracks this in-memory as well.
   */
  markGitHubCredentialsInvalid?(reason: string): Promise<void>;
}

export type ReconcileOptions = {
  store: GitHubReconcileStore;
  client: GitHubClient;
  clock?: Clock;
  /** Poller identity for leases. */
  leaseOwner?: string;
  leaseMs?: number;
  /** Max resources per reconcile pass. */
  batchSize?: number;
  /**
   * When true (Phase 5 default), snapshots and semantic events are persisted
   * but no assignment wakes or outbox dispatches are produced.
   */
  shadowMode?: boolean;
  /**
   * Event wakes. Requires shadowMode=false. When true, after each successful
   * snapshot persist the optional onEventsPersisted hook is invoked so the
   * bug controller can reduce events into exact assignment wakes.
   */
  eventWakeEnabled?: boolean;
  /** Injectable jitter for backoff tests (0..1). */
  random?: () => number;
  /** Called once when credentials are invalid. */
  onInvalidCredentials?: (reason: string) => void;
  /** Called on rate-limit backoff (observability). */
  onRateLimited?: (info: {
    resourceId: string;
    retryAfterMs: number;
  }) => void;
  /**
   * Phase 6 wake hook. Invoked only when eventWakeEnabled && !shadowMode and
   * events were persisted. Should reduce events and enqueue assignment wakes.
   * Returns number of wakes enqueued (for pass.wakesDelivered).
   */
  onEventsPersisted?: (result: ShadowPersistResult) => Promise<number>;
};

export type ReconcilePassResult = {
  examined: number;
  updated: number;
  eventsEmitted: number;
  failures: number;
  rateLimited: number;
  credentialsInvalid: boolean;
  wakeGapDetected: boolean;
  /** Always empty / false in Phase 5 shadow paths. */
  wakesDelivered: number;
  results: ShadowPersistResult[];
};

/**
 * Detect laptop sleep / long pause: gap larger than two poll intervals.
 * Startup (lastTickAt === null) is treated as a reconcile-needed gap.
 */
export function shouldReconcileForWakeGap(
  lastTickAt: number | null,
  now: number,
  intervalMs: number,
): boolean {
  if (lastTickAt == null) return true;
  return now - lastTickAt > intervalMs * 2;
}

/**
 * Exponential backoff with jitter, Retry-After honored, 15-minute ceiling.
 */
export function computeBackoffMs(
  consecutiveFailures: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(Math.floor(retryAfterMs), GITHUB_BACKOFF_CEILING_MS);
  }
  const exp = Math.min(
    GITHUB_POLL_HOT_MS * 2 ** Math.max(0, consecutiveFailures),
    GITHUB_BACKOFF_CEILING_MS,
  );
  const jitter = Math.floor(exp * 0.2 * clamp01(random()));
  return Math.min(exp + jitter, GITHUB_BACKOFF_CEILING_MS);
}

export function nextPollAtForClass(
  now: number,
  pollClass: GitHubPollClass,
): number {
  const interval =
    pollClass === "hot" ? GITHUB_POLL_HOT_MS : GITHUB_POLL_WARM_MS;
  return now + interval;
}

export function isTerminalSnapshot(snapshot: PrSnapshot): boolean {
  return snapshot.state === "MERGED" || snapshot.state === "CLOSED";
}

/**
 * Pure-function startup / periodic reconcile hook.
 * Does not dispatch agents. Does not enqueue wake outbox records.
 */
export async function reconcileTrackedResources(
  options: ReconcileOptions & {
    /** When set, resources with next_poll_at in the future are still examined. */
    forceAllActive?: boolean;
    lastTickAt?: number | null;
    intervalMs?: number;
  },
): Promise<ReconcilePassResult> {
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const leaseOwner = options.leaseOwner ?? "github-reconciler";
  const leaseMs = options.leaseMs ?? 60_000;
  const batchSize = options.batchSize ?? 20;
  const shadowMode = options.shadowMode !== false;
  const eventWakeEnabled = options.eventWakeEnabled === true;
  const random = options.random ?? Math.random;
  const intervalMs = options.intervalMs ?? GITHUB_POLL_HOT_MS;

  // Wakes only when explicitly enabled and not in shadow mode.
  const allowWakes = !shadowMode && eventWakeEnabled;

  const wakeGapDetected = shouldReconcileForWakeGap(
    options.lastTickAt ?? null,
    now,
    intervalMs,
  );

  const force = options.forceAllActive === true || wakeGapDetected;
  const resources = force
    ? (await options.store.listActiveTrackedResources()).slice(0, batchSize)
    : await options.store.listDueGitHubResources(now, batchSize);

  const pass: ReconcilePassResult = {
    examined: 0,
    updated: 0,
    eventsEmitted: 0,
    failures: 0,
    rateLimited: 0,
    credentialsInvalid: false,
    wakeGapDetected,
    wakesDelivered: 0,
    results: [],
  };

  // Prefer node-id batching when available.
  const withNodeIds = resources.filter((r) => r.nodeId);
  const withoutNodeIds = resources.filter((r) => !r.nodeId);

  if (withNodeIds.length > 0) {
    const claimed: GitHubResource[] = [];
    for (const resource of withNodeIds) {
      const ok = await options.store.claimGitHubResourceLease(
        resource.id,
        leaseOwner,
        leaseMs,
        now,
      );
      if (ok) claimed.push(resource);
    }
    if (claimed.length > 0) {
      let byNodeId: Map<
        string,
        Awaited<ReturnType<GitHubClient["fetchPullRequest"]>>
      >;
      try {
        byNodeId = await options.client.fetchPullRequestsByNodeIds(
          claimed.map((r) => r.nodeId!),
        );
      } catch (err) {
        // Never abort the whole pass / strand leases on CLI/transport throws.
        const error = err instanceof Error ? err.message : String(err);
        const invalidCredentials = /401|bad credentials|unauthorized/i.test(
          error,
        );
        for (const resource of claimed) {
          pass.examined += 1;
          const one = await applyFetchResult({
            resource,
            fetchResult: {
              ok: false,
              error,
              ...(invalidCredentials ? { invalidCredentials: true } : {}),
            },
            store: options.store,
            clock,
            random,
            onInvalidCredentials: options.onInvalidCredentials,
            onRateLimited: options.onRateLimited,
            allowWakes,
            onEventsPersisted: options.onEventsPersisted,
          });
          mergePass(pass, one);
        }
        byNodeId = new Map();
      }
      // All-null / all-error batch with auth signal → halt once.
      if (
        claimed.length > 0 &&
        [...byNodeId.values()].every(
          (r) =>
            r &&
            !r.ok &&
            ("invalidCredentials" in r ? r.invalidCredentials : false),
        )
      ) {
        pass.credentialsInvalid = true;
      }
      for (const resource of claimed) {
        if (pass.credentialsInvalid && byNodeId.size === 0) break;
        pass.examined += 1;
        const fetchResult = byNodeId.get(resource.nodeId!) ?? {
          ok: false as const,
          error: "missing batch result",
        };
        const one = await applyFetchResult({
          resource,
          fetchResult,
          store: options.store,
          clock,
          random,
          onInvalidCredentials: options.onInvalidCredentials,
          onRateLimited: options.onRateLimited,
          allowWakes,
          onEventsPersisted: options.onEventsPersisted,
        });
        mergePass(pass, one);
        if (pass.credentialsInvalid) break;
      }
    }
  }

  for (const resource of withoutNodeIds) {
    if (pass.credentialsInvalid) break;
    const ok = await options.store.claimGitHubResourceLease(
      resource.id,
      leaseOwner,
      leaseMs,
      now,
    );
    if (!ok) continue;
    pass.examined += 1;
    let fetchResult: Awaited<ReturnType<GitHubClient["fetchPullRequest"]>>;
    try {
      fetchResult = await options.client.fetchPullRequest(
        resource.owner,
        resource.repo,
        resource.number,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      fetchResult = {
        ok: false,
        error,
        ...(/401|bad credentials|unauthorized/i.test(error)
          ? { invalidCredentials: true as const }
          : {}),
      };
    }
    const one = await applyFetchResult({
      resource,
      fetchResult,
      store: options.store,
      clock,
      random,
      onInvalidCredentials: options.onInvalidCredentials,
      onRateLimited: options.onRateLimited,
      allowWakes,
      onEventsPersisted: options.onEventsPersisted,
    });
    mergePass(pass, one);
    if (pass.credentialsInvalid) break;
  }

  return pass;
}

async function applyFetchResult(args: {
  resource: GitHubResource;
  fetchResult: Awaited<ReturnType<GitHubClient["fetchPullRequest"]>>;
  store: GitHubReconcileStore;
  clock: Clock;
  random: () => number;
  onInvalidCredentials?: (reason: string) => void;
  onRateLimited?: (info: { resourceId: string; retryAfterMs: number }) => void;
  allowWakes?: boolean;
  onEventsPersisted?: (result: ShadowPersistResult) => Promise<number>;
}): Promise<{
  updated: number;
  eventsEmitted: number;
  failures: number;
  rateLimited: number;
  credentialsInvalid: boolean;
  wakesDelivered?: number;
  result?: ShadowPersistResult;
}> {
  const { resource, fetchResult, store, clock, random } = args;
  const now = clock.now();

  if (!fetchResult.ok) {
    if (fetchResult.invalidCredentials) {
      args.onInvalidCredentials?.(fetchResult.error);
      await store.markGitHubCredentialsInvalid?.(fetchResult.error);
      await store.recordGitHubPollFailure(
        resource.id,
        fetchResult.error,
        now + GITHUB_BACKOFF_CEILING_MS,
      );
      await store.releaseGitHubResourceLease(resource.id);
      return {
        updated: 0,
        eventsEmitted: 0,
        failures: 1,
        rateLimited: 0,
        credentialsInvalid: true,
      };
    }

    const failures = resource.consecutiveFailures + 1;
    const backoff = computeBackoffMs(
      failures,
      fetchResult.rateLimited ? fetchResult.retryAfterMs : undefined,
      random,
    );
    if (fetchResult.rateLimited) {
      args.onRateLimited?.({
        resourceId: resource.id,
        retryAfterMs: backoff,
      });
    }
    await store.recordGitHubPollFailure(
      resource.id,
      fetchResult.error,
      now + backoff,
    );
    await store.releaseGitHubResourceLease(resource.id);
    return {
      updated: 0,
      eventsEmitted: 0,
      failures: 1,
      rateLimited: fetchResult.rateLimited ? 1 : 0,
      credentialsInvalid: false,
    };
  }

  const associations = await store.listAssociationsForResource(
    resource.id,
    true,
  );
  const events = diffPrSnapshots(resource.snapshot, fetchResult.snapshot, {
    resourceId: resource.id,
    owner: resource.owner,
    repo: resource.repo,
    number: resource.number,
    observedAt: now,
  });
  const proposedReductions = proposeReductionsForEvents(events, associations);
  const terminal = isTerminalSnapshot(fetchResult.snapshot);
  const nextPollAt = terminal
    ? now + GITHUB_BACKOFF_CEILING_MS
    : nextPollAtForClass(now, resource.pollClass);

  const result = await store.applyGitHubSnapshotShadow({
    resourceId: resource.id,
    snapshot: fetchResult.snapshot,
    nodeId: fetchResult.nodeId,
    events,
    proposedReductions,
    nextPollAt,
    pollClass: resource.pollClass,
    terminalAt: terminal ? now : null,
    wakeEnabled: args.allowWakes === true,
  });

  // Store never delivers wakes itself — controller hook does.
  let wakesDelivered = 0;
  if (
    args.allowWakes &&
    args.onEventsPersisted &&
    result.events.length > 0
  ) {
    wakesDelivered = await args.onEventsPersisted(result);
  }

  await store.releaseGitHubResourceLease(resource.id);

  return {
    updated: 1,
    eventsEmitted: events.length,
    failures: 0,
    rateLimited: 0,
    wakesDelivered,
    credentialsInvalid: false,
    result,
  };
}

function mergePass(
  pass: ReconcilePassResult,
  one: {
    updated: number;
    eventsEmitted: number;
    failures: number;
    rateLimited: number;
    credentialsInvalid: boolean;
    wakesDelivered?: number;
    result?: ShadowPersistResult;
  },
): void {
  pass.updated += one.updated;
  pass.eventsEmitted += one.eventsEmitted;
  pass.failures += one.failures;
  pass.rateLimited += one.rateLimited;
  pass.wakesDelivered += one.wakesDelivered ?? 0;
  if (one.credentialsInvalid) pass.credentialsInvalid = true;
  if (one.result) pass.results.push(one.result);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
