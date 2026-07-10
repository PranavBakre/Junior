import { describe, expect, it } from "bun:test";
import type { WebClient } from "@slack/web-api";

import type { MemorySourceRecord } from "../types.ts";
import { createSlackPeopleResolver, referencedSlackUserIds } from "./identity.ts";

function record(over: Partial<MemorySourceRecord>): MemorySourceRecord {
  return {
    id: "r1",
    kind: "slack_message",
    threadId: "T1",
    actorId: null,
    actorKind: "human",
    agentName: null,
    channelId: null,
    slackTs: null,
    sourceUrl: null,
    repoName: null,
    metadata: null,
    body: "",
    createdAt: 0,
    consolidatedAt: null,
    ...over,
  } as MemorySourceRecord;
}

/** Fake users.info client. NOTE: ids must be unique per test — resolveUserName caches per process. */
function fakeClient(names: Record<string, string | Error>): WebClient {
  return {
    users: {
      info: async ({ user }: { user: string }) => {
        const entry = names[user];
        if (entry === undefined || entry instanceof Error) throw entry ?? new Error("unknown user");
        return { user: { profile: { display_name: entry } } };
      },
    },
  } as unknown as WebClient;
}

describe("referencedSlackUserIds", () => {
  it("collects author ids and <@…> mentions, deduped", () => {
    const ids = referencedSlackUserIds([
      record({ id: "a", actorId: "U03PNSJ33S5", body: "review <@U0ABKQ4V065> please" }),
      record({ id: "b", actorId: "U03PNSJ33S5", body: "done?" }),
    ]);
    expect(ids.sort()).toEqual(["U03PNSJ33S5", "U0ABKQ4V065"]);
  });

  it("ignores non-Slack actor ids (agent names, nulls)", () => {
    const ids = referencedSlackUserIds([
      record({ id: "a", actorId: "junior-orchestrator", body: "no mentions here" }),
      record({ id: "b", actorId: null }),
    ]);
    expect(ids).toEqual([]);
  });
});

describe("createSlackPeopleResolver", () => {
  it("maps resolvable ids to display names and drops failures", async () => {
    const resolver = createSlackPeopleResolver(
      fakeClient({ UIDTESTOK1: "Pranav Bakre", UIDTESTBAD1: new Error("boom") }),
    );
    const resolved = await resolver(["UIDTESTOK1", "UIDTESTBAD1"]);
    expect(resolved.get("UIDTESTOK1")).toBe("Pranav Bakre");
    expect(resolved.has("UIDTESTBAD1")).toBe(false);
  });
});
