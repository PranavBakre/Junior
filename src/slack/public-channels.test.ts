import { describe, expect, test } from "bun:test";
import { createPublicChannelDirectory, type PublicChannelLister } from "./public-channels.ts";

type ListPage = Awaited<ReturnType<PublicChannelLister["conversations"]["list"]>>;

function lister(pages: ListPage[]) {
  const calls: (string | undefined)[] = [];
  let index = 0;
  const client: PublicChannelLister = {
    conversations: {
      async list(args) {
        calls.push(args.cursor);
        return pages[index++ % pages.length]!;
      },
    },
  };
  return { client, calls };
}

describe("createPublicChannelDirectory", () => {
  test("paginates once and answers membership from the cached set", async () => {
    const { client, calls } = lister([
      { ok: true, channels: [{ id: "C1", is_channel: true }], response_metadata: { next_cursor: "next" } },
      { ok: true, channels: [{ id: "C2", is_channel: true }, { id: "G1", is_channel: true, is_private: true }] },
    ]);
    const directory = createPublicChannelDirectory(() => client);
    const answers = await Promise.all(["C1", "C2", "G1", "D1"].map((id) => directory.isPublic(id)));
    expect(answers).toEqual([true, true, false, false]);
    expect(calls).toEqual([undefined, "next"]);
  });

  test("refetches after the TTL expires", async () => {
    let clock = 0;
    const { client, calls } = lister([{ ok: true, channels: [{ id: "C1", is_channel: true }] }]);
    const directory = createPublicChannelDirectory(() => client, { ttlMs: 1_000, now: () => clock });
    await directory.isPublic("C1");
    clock = 500;
    await directory.isPublic("C1");
    expect(calls.length).toBe(1);
    clock = 1_500;
    await directory.isPublic("C1");
    expect(calls.length).toBe(2);
  });

  test("fails closed and does not cache a failed fetch", async () => {
    const { client, calls } = lister([
      { ok: false, error: "ratelimited" },
      { ok: true, channels: [{ id: "C1", is_channel: true }] },
    ]);
    const directory = createPublicChannelDirectory(() => client);
    expect(await directory.isPublic("C1")).toBe(false);
    expect(await directory.isPublic("C1")).toBe(true);
    expect(calls.length).toBe(2);
  });

  test("discards a partial set when a later page throws", async () => {
    let attempt = 0;
    const client: PublicChannelLister = {
      conversations: {
        async list(args) {
          attempt++;
          if (!args.cursor) {
            return { ok: true, channels: [{ id: "C1", is_channel: true }], response_metadata: { next_cursor: "next" } };
          }
          if (attempt === 2) throw new Error("ratelimited");
          return { ok: true, channels: [{ id: "C2", is_channel: true }] };
        },
      },
    };
    const directory = createPublicChannelDirectory(() => client);
    expect(await directory.isPublic("C1")).toBe(false);
    expect(await directory.isPublic("C1")).toBe(true);
    expect(await directory.isPublic("C2")).toBe(true);
    expect(attempt).toBe(4);
  });
});
