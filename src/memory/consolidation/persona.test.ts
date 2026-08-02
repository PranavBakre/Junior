import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../profiles/store.ts";
import { SqliteMemoryStore } from "../sqlite.ts";
import type { ConsolidationInvoke } from "./types.ts";
import { runPersonaConsolidationSweep } from "./persona.ts";

describe("runPersonaConsolidationSweep", () => {
  it("builds a person profile from recent evidence across several threads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-persona-"));
    const store = new SqliteMemoryStore(join(dir, "memory.db"));
    const profileStore = new ProfileStore({ root: join(dir, "profiles") });
    try {
      const records = [
        { id: "m1", threadId: "T1", body: "Please keep the answer terse." },
        { id: "m2", threadId: "T2", body: "This is too verbose; just give me the result." },
        { id: "m3", threadId: "T3", body: "Short, direct updates work best for me." },
      ];
      for (const [index, record] of records.entries()) {
        await store.appendSourceRecord({
          ...record,
          kind: "slack_message",
          actorId: "U12345",
          actorKind: "human",
          createdAt: index + 1,
        });
      }
      const prompts: string[] = [];
      const invoke: ConsolidationInvoke = async (prompt) => {
        prompts.push(prompt);
        return {
          episodes: [],
          claims: [],
          profiles: [{
            kind: "person",
            entity_ref: "alex-doe:person",
            comms_style: "terse and direct",
            preferences: ["result-first answers"],
            evidence: ["m1", "m2", "not-a-source"],
            body: "Alex consistently asks for concise, result-first communication.",
          }],
        };
      };

      const reports = await runPersonaConsolidationSweep({
        store,
        profileStore,
        invoke,
        resolvePeople: async () => new Map([["U12345", "Alex Doe"]]),
        pendingRecords: [{
          id: "m3",
          kind: "slack_message",
          actorId: "U12345",
          actorKind: "human",
          threadId: "T3",
          body: records[2].body,
          createdAt: 3,
        }],
      });

      expect(reports).toEqual([expect.objectContaining({
        actorId: "U12345",
        recordsReviewed: 3,
        profileUpdated: true,
      })]);
      expect(prompts[0]).toContain("thread=T1");
      expect(prompts[0]).toContain("thread=T3");
      const profile = await profileStore.fetchByEntityRef("alex-doe:person");
      expect(profile).toMatchObject({
        kind: "person",
        slack_user_id: "U12345",
        comms_style: "terse and direct",
        evidence: ["m1", "m2"],
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not invoke the model below the minimum evidence threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-persona-small-"));
    const store = new SqliteMemoryStore(join(dir, "memory.db"));
    const profileStore = new ProfileStore({ root: join(dir, "profiles") });
    try {
      const record = {
        id: "m1",
        kind: "slack_message" as const,
        actorId: "U12345",
        actorKind: "human" as const,
        body: "thanks",
        createdAt: 1,
      };
      await store.appendSourceRecord(record);
      let invoked = false;
      const reports = await runPersonaConsolidationSweep({
        store,
        profileStore,
        invoke: async () => {
          invoked = true;
          return { episodes: [], profiles: [], claims: [] };
        },
        resolvePeople: async () => new Map([["U12345", "Alex Doe"]]),
        pendingRecords: [record],
      });
      expect(invoked).toBe(false);
      expect(reports[0]?.skippedReason).toContain("fewer than 3");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts a legacy short-name profile instead of forking a duplicate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-persona-legacy-"));
    const store = new SqliteMemoryStore(join(dir, "memory.db"));
    const profileStore = new ProfileStore({ root: join(dir, "profiles") });
    try {
      await profileStore.upsertProfile({ kind: "person", entity_ref: "pranav:person", body: "Existing." });
      const records = ["one", "two", "three"].map((body, index) => ({
        id: `m${index}`,
        kind: "slack_message" as const,
        actorId: "U99999",
        actorKind: "human" as const,
        body,
        createdAt: index + 1,
      }));
      for (const record of records) await store.appendSourceRecord(record);
      const reports = await runPersonaConsolidationSweep({
        store,
        profileStore,
        resolvePeople: async () => new Map([["U99999", "Pranav Bakre"]]),
        pendingRecords: [records[2]],
        invoke: async () => ({
          episodes: [], claims: [], profiles: [{
            kind: "person",
            entity_ref: "pranav:person",
            body: "Updated.",
          }],
        }),
      });
      expect(reports[0]?.entityRef).toBe("pranav:person");
      expect(await profileStore.fetchByEntityRef("pranav-bakre:person")).toBeNull();
      expect(await profileStore.fetchByEntityRef("pranav:person")).toMatchObject({
        slack_user_id: "U99999",
        body: "Updated.",
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
