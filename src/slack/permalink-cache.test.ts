import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SlackPermalinkCache,
  SqliteSlackPermalinkStore,
} from "./permalink-cache.ts";

function counting(permalink: string | null = "https://slack.example/p1") {
  let calls = 0;
  return {
    calls: () => calls,
    resolve: async () => {
      calls++;
      return permalink;
    },
  };
}

describe("SlackPermalinkCache", () => {
  it("calls Slack once and serves later requests from memory", async () => {
    const slack = counting();
    const cache = new SlackPermalinkCache({ resolve: slack.resolve });

    expect(await cache.resolve("C1", "1.1")).toBe("https://slack.example/p1");
    expect(await cache.resolve("C1", "1.1")).toBe("https://slack.example/p1");
    expect(cache.lookup("C1", "1.1")).toBe("https://slack.example/p1");
    expect(slack.calls()).toBe(1);
  });

  it("collapses a concurrent burst into a single Slack call", async () => {
    const slack = counting();
    const cache = new SlackPermalinkCache({ resolve: slack.resolve });

    const results = await Promise.all(
      Array.from({ length: 25 }, () => cache.resolve("C1", "1.1")),
    );

    expect(new Set(results)).toEqual(new Set(["https://slack.example/p1"]));
    expect(slack.calls()).toBe(1);
  });

  it("returns null from lookup without ever calling Slack", async () => {
    const slack = counting();
    const cache = new SlackPermalinkCache({ resolve: slack.resolve });

    expect(cache.lookup("C1", "1.1")).toBeNull();
    expect(slack.calls()).toBe(0);
  });

  it("holds misses for the negative TTL, then retries", async () => {
    let calls = 0;
    let now = 1_000;
    const cache = new SlackPermalinkCache({
      now: () => now,
      resolve: async () => {
        calls++;
        return calls === 1 ? null : "https://slack.example/p1";
      },
    });

    expect(await cache.resolve("C1", "1.1")).toBeNull();
    expect(await cache.resolve("C1", "1.1")).toBeNull();
    expect(calls).toBe(1);

    now += 61_000;
    expect(await cache.resolve("C1", "1.1")).toBe("https://slack.example/p1");
    expect(calls).toBe(2);
  });

  it("treats a thrown Slack error as a miss instead of propagating", async () => {
    const cache = new SlackPermalinkCache({
      resolve: async () => {
        throw new Error("ratelimited");
      },
    });

    expect(await cache.resolve("C1", "1.1")).toBeNull();
  });

  it("survives a restart by reading the persisted store", async () => {
    const db = new Database(":memory:");
    const store = new SqliteSlackPermalinkStore(db);
    const first = counting();
    await new SlackPermalinkCache({ resolve: first.resolve, store })
      .resolve("C1", "1.1");
    expect(first.calls()).toBe(1);

    const second = counting();
    const restarted = new SlackPermalinkCache({ resolve: second.resolve, store });
    expect(restarted.lookup("C1", "1.1")).toBe("https://slack.example/p1");
    expect(await restarted.resolve("C1", "1.1")).toBe("https://slack.example/p1");
    expect(second.calls()).toBe(0);
  });

  it("ignores blank channel or timestamp", async () => {
    const slack = counting();
    const cache = new SlackPermalinkCache({ resolve: slack.resolve });

    expect(await cache.resolve("", "1.1")).toBeNull();
    expect(await cache.resolve("C1", "")).toBeNull();
    expect(cache.lookup("", "")).toBeNull();
    expect(slack.calls()).toBe(0);
  });
});
