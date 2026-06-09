import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SlackActionStore } from "./action-store.ts";

function withStore(fn: (store: SlackActionStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "junior-actions-"));
  const store = new SlackActionStore(join(dir, "actions.sqlite"));
  return fn(store).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("SlackActionStore", () => {
  it("claims active actions only once", async () => {
    await withStore(async (store) => {
      await store.createMany([
        {
          token: "tok-1",
          channelId: "C1",
          threadTs: "100.1",
          messageTs: "101.1",
          messageText: "review: changes-requested",
          sourceAgent: "review",
          action: {
            id: "review:rereview",
            label: "Re-review",
            type: "dispatch_agent",
            agent: "review",
            prompt: "re-review",
          },
        },
      ]);

      const claimed = await store.claim("tok-1", "U1", 123);
      expect(claimed?.status).toBe("clicked");
      expect(claimed?.clickedByUserId).toBe("U1");
      expect(await store.claim("tok-1", "U2", 124)).toBeNull();
    });
  });

  it("disables active actions for a source agent in a thread", async () => {
    await withStore(async (store) => {
      await store.createMany([
        {
          token: "old-review",
          channelId: "C1",
          threadTs: "100.1",
          messageTs: "101.1",
          messageText: "old review",
          sourceAgent: "review",
          action: {
            id: "review:rereview",
            label: "Re-review",
            type: "dispatch_agent",
            agent: "review",
            prompt: "re-review",
          },
        },
        {
          token: "thinker",
          channelId: "C1",
          threadTs: "100.1",
          messageTs: "102.1",
          messageText: "thinker",
          sourceAgent: "thinker",
          action: {
            id: "thread:cleanup-worktree",
            label: "Cleanup worktree",
            type: "cleanup_worktree",
          },
        },
      ]);

      const disabled = await store.disableSourceAgentActions("100.1", "review");
      expect(disabled).toEqual([
        { channelId: "C1", messageTs: "101.1", messageText: "old review" },
      ]);
      expect(await store.claim("old-review", "U1")).toBeNull();
      expect((await store.claim("thinker", "U1"))?.status).toBe("clicked");
    });
  });
});
