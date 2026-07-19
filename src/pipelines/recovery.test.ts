import { describe, expect, it } from "bun:test";
import { fakeClock } from "../time/clock.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import { makeProductRun } from "./store/test-helpers.ts";
import { recoverPipelineRuntime } from "./recovery.ts";
import type { GitHubResource } from "../github/types.ts";

function makeGitHubResource(
  overrides: Partial<GitHubResource> = {},
): GitHubResource {
  const now = overrides.createdAt ?? 1000;
  return {
    id: "gh-1",
    kind: "pull_request",
    owner: "org",
    repo: "backend",
    number: 1,
    nodeId: null,
    snapshot: null,
    lastPolledAt: null,
    nextPollAt: now,
    pollClass: "hot",
    consecutiveFailures: 0,
    lastError: null,
    leaseOwner: null,
    leaseUntil: null,
    terminalAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("recoverPipelineRuntime", () => {
  it("reclaims expired outbox and github leases without stealing live ones", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeProductRun());

    // Outbox: claim under worker-a, then expire.
    await store.enqueueOutbox({
      id: "ob-1",
      runId: "run-1",
      assignmentId: null,
      eventType: "assignment.dispatch",
      payload: { assignmentId: "asg-1" },
      idempotencyKey: "ob-1",
    });
    const claimed = await store.claimOutbox("worker-a", 10, 5_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("leased");

    // GitHub: live lease + expired lease.
    await store.upsertGitHubResource(
      makeGitHubResource({
        id: "gh-live",
        leaseOwner: "reconciler-a",
        leaseUntil: 1000 + 60_000,
      }),
    );
    await store.upsertGitHubResource(
      makeGitHubResource({
        id: "gh-expired",
        number: 2,
        leaseOwner: "reconciler-b",
        leaseUntil: 1000 + 1_000,
      }),
    );

    // Before expiry: recovery should not steal live leases.
    let report = await recoverPipelineRuntime(store, clock);
    expect(report.reclaimedOutboxLeases).toBe(0);
    expect(report.reclaimedGitHubLeases).toBe(0);

    clock.advance(6_000);
    report = await recoverPipelineRuntime(store, clock);
    expect(report.reclaimedOutboxLeases).toBe(1);
    expect(report.reclaimedGitHubLeases).toBe(1);

    const live = await store.getGitHubResource("gh-live");
    expect(live?.leaseOwner).toBe("reconciler-a");

    const expired = await store.getGitHubResource("gh-expired");
    expect(expired?.leaseOwner).toBeNull();
    expect(expired?.leaseUntil).toBeNull();

    // Outbox can be reclaimed and re-claimed by another worker.
    const again = await store.claimOutbox("worker-b", 10, 5_000);
    expect(again).toHaveLength(1);
    expect(again[0]!.leaseOwner).toBe("worker-b");
  });

  it("reclaims expired dev-server acquire leases", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeProductRun({ id: "run-ds", threadId: "T-ds" }));
    await store.createDevServerJob({
      id: "job-1",
      runId: "run-ds",
      assignmentId: "asg-ds",
      channelId: "C1",
      threadId: "T-ds",
      repo: "backend",
      branch: "feat",
      status: "acquiring",
      deadlineAt: 1000 + 600_000,
    });
    await store.updateDevServerJob("job-1", {
      leaseOwner: "worker-a",
      leaseExpiresAt: 1000 + 2_000,
    });

    clock.advance(3_000);
    const report = await recoverPipelineRuntime(store, clock);
    expect(report.reclaimedDevServerLeases).toBe(1);

    const job = await store.getDevServerJob("job-1");
    expect(job?.leaseOwner).toBeNull();
    expect(job?.status).toBe("queued");
  });
});
