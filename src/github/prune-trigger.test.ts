import { describe, expect, it } from "bun:test";
import {
  MergePruneDispatcher,
  mergedPullRequestPruneTargets,
  type MergedPullRequestPruneTarget,
} from "./prune-trigger.ts";
import type { GitHubSemanticEvent, ShadowPersistResult } from "./types.ts";

function result(events: GitHubSemanticEvent[]): ShadowPersistResult {
  return {
    resourceId: "resource-1",
    events,
    proposedReductions: [],
    wakesDelivered: false,
    associationsTouched: 1,
  };
}

function event(
  type: GitHubSemanticEvent["type"],
  overrides: Partial<GitHubSemanticEvent> = {},
): GitHubSemanticEvent {
  return {
    type,
    resourceId: "resource-1",
    owner: "acme",
    repo: "widgets",
    number: 42,
    observedAt: 1_000,
    previous: { state: "OPEN" },
    next: {
      state: "MERGED",
      headRefName: "agent/fix-widgets",
      headRefOid: "abc123",
    },
    fingerprint: `resource-1:${type}`,
    ...overrides,
  };
}

describe("mergedPullRequestPruneTargets", () => {
  it("returns exact repo and branch targets for merge events", () => {
    expect(
      mergedPullRequestPruneTargets([
        result([
          event("github.pr.checks_changed"),
          event("github.pr.merged"),
        ]),
      ]),
    ).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        number: 42,
        branch: "agent/fix-widgets",
        headSha: "abc123",
      },
    ]);
  });

  it("deduplicates a PR and ignores incomplete merge events", () => {
    const merged = event("github.pr.merged");
    expect(
      mergedPullRequestPruneTargets([
        result([merged]),
        result([
          merged,
          event("github.pr.merged", { next: { state: "MERGED" } }),
        ]),
      ]),
    ).toHaveLength(1);
  });
});

describe("MergePruneDispatcher", () => {
  it("serializes targets that arrive during an active prune run", async () => {
    const runs: MergedPullRequestPruneTarget[][] = [];
    const releases: Array<() => void> = [];
    const dispatcher = new MergePruneDispatcher({
      run: async (targets) => {
        runs.push([...targets]);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { runId: `run-${runs.length}` };
      },
    });

    dispatcher.enqueue([result([event("github.pr.merged")])]);
    await waitFor(() => runs.length === 1);
    dispatcher.enqueue([
      result([
        event("github.pr.merged", {
          repo: "gadgets",
          number: 43,
          next: {
            state: "MERGED",
            headRefName: "agent/fix-gadgets",
            headRefOid: "def456",
          },
        }),
      ]),
    ]);

    expect(runs).toHaveLength(1);
    releases[0]?.();
    await waitFor(() => runs.length === 2);
    expect(runs[1]?.[0]).toMatchObject({
      repo: "gadgets",
      branch: "agent/fix-gadgets",
    });
    releases[1]?.();
  });

  it("retains targets when the workflow scheduler reports an overlap skip", async () => {
    const runs: MergedPullRequestPruneTarget[][] = [];
    let retry: (() => void) | undefined;
    const dispatcher = new MergePruneDispatcher({
      run: async (targets) => {
        runs.push([...targets]);
        return { runId: runs.length === 1 ? "" : "run-2" };
      },
      scheduleRetry: (callback) => {
        retry = callback;
      },
    });

    dispatcher.enqueue([result([event("github.pr.merged")])]);
    await waitFor(() => runs.length === 1);
    expect(retry).toBeDefined();
    retry?.();
    await waitFor(() => runs.length === 2);

    expect(runs[1]).toEqual(runs[0]);
  });

  it("retries thrown runs with bounded backoff before exhausting the target", async () => {
    const retries: Array<{ callback: () => void; delayMs: number }> = [];
    const exhausted: MergedPullRequestPruneTarget[] = [];
    let runs = 0;
    const dispatcher = new MergePruneDispatcher({
      run: async () => {
        runs += 1;
        throw new Error("workflow store temporarily unavailable");
      },
      retryDelayMs: 100,
      maxAttempts: 3,
      scheduleRetry: (callback, delayMs) => {
        retries.push({ callback, delayMs });
      },
      onExhausted: (target) => exhausted.push(target),
    });

    dispatcher.enqueue([result([event("github.pr.merged")])]);
    await waitFor(() => retries.length === 1);
    expect(retries[0]?.delayMs).toBe(100);

    retries[0]?.callback();
    await waitFor(() => retries.length === 2);
    expect(retries[1]?.delayMs).toBe(200);

    retries[1]?.callback();
    await waitFor(() => exhausted.length === 1);
    expect(runs).toBe(3);
    expect(exhausted[0]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      number: 42,
    });
    expect(retries).toHaveLength(2);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not met");
}
