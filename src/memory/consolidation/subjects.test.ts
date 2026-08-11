import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../profiles/store.ts";
import { SqliteMemoryStore } from "../sqlite.ts";
import type { MemorySourceRecord } from "../types.ts";
import { canonicalRepoSlug, runSubjectConsolidationSweep } from "./subjects.ts";

describe("cumulative subject consolidation", () => {
  let root: string;
  let store: SqliteMemoryStore;
  let profileStore: ProfileStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junior-subjects-"));
    store = new SqliteMemoryStore(join(root, "memory.db"));
    profileStore = new ProfileStore({ root: join(root, "profiles") });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("groups worktree aliases into one cumulative repo profile", async () => {
    const records = [
      source("r1", "curated_fact", "Use the repository worktree script.", { repoName: "gx-backend.worktrees" }),
      source("r2", "curated_fact", "Typecheck before opening a PR.", { repoName: "gx-backend" }),
      source("r3", "curated_fact", "Migrations require an explicit rollback note.", { repoName: "gx-backend.junior-worktrees" }),
      source("r4", "curated_fact", "Subscription changes use the base repo conventions.", { repoName: "gx-backend-subscription-products-pr" }),
    ];
    for (const record of records) await store.appendSourceRecord(record);

    const reports = await runSubjectConsolidationSweep({
      store,
      profileStore,
      pendingRecords: records,
      minRecords: 3,
      invoke: async (prompt) => {
        expect(prompt).toContain("Required entity_ref: gx-backend:repo");
        return {
          episodes: [], claims: [], profiles: [{
            kind: "repo",
            entity_ref: "gx-backend:repo",
            conventions: ["Use the repository worktree script."],
            evidence: ["r1", "not-real"],
          }],
        };
      },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "repo", subject: "gx-backend:repo", recordsReviewed: 4, profilesUpdated: 1 });
    expect(await profileStore.fetchByEntityRef("gx-backend:repo")).toMatchObject({ evidence: ["r1"] });
    expect(await store.listSourceRepos()).toEqual([
      "gx-backend",
      "gx-backend-subscription-products-pr",
      "gx-backend.junior-worktrees",
      "gx-backend.worktrees",
    ]);
    expect(await store.listSourceRecords({ repoName: "gx-backend", limit: 10 })).toHaveLength(1);
  });

  it("builds recurring situation profiles from a cross-thread Slack window", async () => {
    const records = [
      source("s1", "slack_message", "Please show the evidence before changing this.", { actorId: "U12345", actorKind: "human", threadId: "t1" }),
      source("s2", "slack_message", "Pause—diagnose first and do not edit yet.", { actorId: "U12345", actorKind: "human", threadId: "t2" }),
      source("s3", "slack_message", "What evidence supports that diagnosis?", { actorId: "U67890", actorKind: "human", threadId: "t3" }),
    ];
    for (const record of records) await store.appendSourceRecord(record);

    const reports = await runSubjectConsolidationSweep({
      store,
      profileStore,
      pendingRecords: records,
      minRecords: 3,
      invoke: async () => ({
        episodes: [], claims: [], profiles: [{
          kind: "situation",
          entity_ref: "diagnosis-before-editing:situation",
          pattern: "A request is diagnostic rather than an implementation authorization.",
          signals: ["asks for evidence", "asks what happened"],
          recommended_action: "Explain the cause and wait for explicit authorization before editing.",
          evidence: ["s1", "s2", "s3"],
        }],
      }),
    });

    expect(reports).toEqual([{
      kind: "situation",
      subject: "cross-thread",
      recordsReviewed: 3,
      profilesUpdated: 1,
      skippedReason: undefined,
    }]);
    expect(await profileStore.fetchByEntityRef("diagnosis-before-editing:situation")).not.toBeNull();
  });

  it("normalizes only known worktree container suffixes", () => {
    expect(canonicalRepoSlug("gx-client-next.worktrees")).toBe("gx-client-next");
    expect(canonicalRepoSlug("gx-backend-subscription-products-pr")).toBe("gx-backend-subscription-products-pr");
  });
});

function source(
  id: string,
  kind: MemorySourceRecord["kind"],
  body: string,
  extra: Partial<MemorySourceRecord> = {},
): MemorySourceRecord {
  return {
    id,
    kind,
    body,
    createdAt: Number(id.replace(/\D/g, "")) || Date.now(),
    ...extra,
  };
}
