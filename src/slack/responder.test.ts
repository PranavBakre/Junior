import { describe, it, expect, vi } from "bun:test";
import { SlackResponder } from "./responder.ts";

/**
 * Minimal mock for Slack Bolt App with chat API stubs.
 * Tests control postMessage / update / delete return values per call.
 */
function mockApp(stubs?: {
  postMessageResults?: Array<{ ts: string } | Error>;
  deleteResults?: Array<true | Error>;
  updateResults?: Array<true | Error>;
}) {
  let postIndex = 0;
  let deleteIndex = 0;
  let updateIndex = 0;
  const postMessageResults = stubs?.postMessageResults ?? [];
  const deleteResults = stubs?.deleteResults ?? [];
  const updateResults = stubs?.updateResults ?? [];

  const calls: {
    postMessage: Array<{
      channel: string;
      thread_ts?: string;
      text: string;
      username?: string;
      icon_emoji?: string;
      icon_url?: string;
      blocks?: Array<Record<string, unknown>>;
    }>;
    delete: Array<{ channel: string; ts: string }>;
    update: Array<{ channel: string; ts: string; text: string }>;
  } = {
    postMessage: [],
    delete: [],
    update: [],
  };

  return {
    app: {
      client: {
        chat: {
          postMessage: vi.fn(async (args: Record<string, unknown>) => {
            calls.postMessage.push(
              args as typeof calls.postMessage[number],
            );
            const result = postMessageResults[postIndex++];
            if (result instanceof Error) throw result;
            return result ?? { ts: `mock-ts-${postIndex}` };
          }),
          delete: vi.fn(async (args: Record<string, unknown>) => {
            calls.delete.push(args as typeof calls.delete[number]);
            const result = deleteResults[deleteIndex++];
            if (result instanceof Error) throw result;
            return { ok: true };
          }),
          update: vi.fn(async (args: Record<string, unknown>) => {
            calls.update.push(args as typeof calls.update[number]);
            const result = updateResults[updateIndex++];
            if (result instanceof Error) throw result;
            return { ok: true };
          }),
        },
        reactions: {
          add: vi.fn(async () => ({ ok: true })),
        },
      },
    } as unknown as import("@slack/bolt").App,
    calls,
  };
}

describe("SlackResponder", () => {
  describe("updateStatus then deleteStatus (normal flow)", () => {
    it("posts a status message, then deletes it when the final response is ready", async () => {
      const { app, calls } = mockApp({
        postMessageResults: [{ ts: "status-ts-1" }],
      });
      const responder = new SlackResponder(app);

      await responder.updateStatus("C123", "1234567890.123456", "Working...");
      expect(calls.postMessage).toHaveLength(1);
      expect(calls.postMessage[0].text).toBe("Working...");

      await responder.deleteStatus("C123", "1234567890.123456");
      expect(calls.delete).toHaveLength(1);
      expect(calls.delete[0].ts).toBe("status-ts-1");
    });
  });

  describe("deleteStatus before updateStatus completes (race condition)", () => {
    it("deleteStatus awaits in-flight postMessage and deletes the resulting message", async () => {
      let resolvePost: (value: unknown) => void;
      const postPromise = new Promise((resolve) => {
        resolvePost = resolve;
      });

      const calls: Array<{ method: string; args: Record<string, unknown> }> =
        [];
      const app = {
        client: {
          chat: {
            postMessage: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "postMessage", args });
              // Hold the promise until we signal
              await postPromise;
              return { ts: "status-ts-race" };
            }),
            delete: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "delete", args });
              return { ok: true };
            }),
            update: vi.fn(async () => ({ ok: true })),
          },
          reactions: { add: vi.fn(async () => ({ ok: true })) },
        },
      } as unknown as import("@slack/bolt").App;
      const responder = new SlackResponder(app);

      // Start updateStatus (will hang on postMessage)
      const updatePromise = responder.updateStatus(
        "C123",
        "1234567890.123456",
        "Working...",
        "default",
      );

      // While updateStatus is in flight, call deleteStatus
      // It should await the pending postMessage, then delete the message
      const deletePromise = responder.deleteStatus(
        "C123",
        "1234567890.123456",
        "default",
      );

      // Now let updateStatus's postMessage complete
      resolvePost!({ ts: "status-ts-race" });

      await Promise.all([updatePromise, deletePromise]);

      // The status message should have been posted (by updateStatus)
      const postCalls = calls.filter((c) => c.method === "postMessage");
      expect(postCalls).toHaveLength(1);

      // The delete call should target the status message (inflight path)
      const deleteCalls = calls.filter((c) => c.method === "delete");
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args.ts).toBe("status-ts-race");
    });

    it("allows new status messages after a completed turn (no permanent block)", async () => {
      const { app, calls } = mockApp({
        postMessageResults: [
          { ts: "status-ts-1" },
          { ts: "status-ts-2" },
        ],
      });
      const responder = new SlackResponder(app);

      // Turn 1: post status, then delete
      await responder.updateStatus("C123", "1234567890.123456", "Turn 1...", "default");
      expect(calls.postMessage).toHaveLength(1);

      await responder.deleteStatus("C123", "1234567890.123456", "default");
      expect(calls.delete).toHaveLength(1);
      expect(calls.delete[0].ts).toBe("status-ts-1");

      // Turn 2: new updateStatus should work — no permanent blocking
      await responder.updateStatus("C123", "1234567890.123456", "Turn 2...", "default");
      expect(calls.postMessage).toHaveLength(2);
      expect(calls.postMessage[1].text).toBe("Turn 2...");

      // Turn 2: delete should also work
      await responder.deleteStatus("C123", "1234567890.123456", "default");
      expect(calls.delete).toHaveLength(2);
      expect(calls.delete[1].ts).toBe("status-ts-2");
    });
  });

  describe("deleteStatus with no prior updateStatus (noop)", () => {
    it("handles deleteStatus gracefully when there is no status message", async () => {
      const { app, calls } = mockApp();
      const responder = new SlackResponder(app);

      await responder.deleteStatus("C123", "1234567890.123456", "default");
      // No delete call should be made
      expect(calls.delete).toHaveLength(0);
    });
  });

  describe("postMessage failure during race", () => {
    it("handles postMessage rejection gracefully during race", async () => {
      let rejectPost: (reason: Error) => void;
      const postPromise = new Promise((_resolve, reject) => {
        rejectPost = reject;
      });

      const calls: Array<{ method: string; args: Record<string, unknown> }> =
        [];
      const app = {
        client: {
          chat: {
            postMessage: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "postMessage", args });
              await postPromise;
              // Unreachable — promise is rejected
              return { ts: "never" };
            }),
            delete: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "delete", args });
              return { ok: true };
            }),
            update: vi.fn(async () => ({ ok: true })),
          },
          reactions: { add: vi.fn(async () => ({ ok: true })) },
        },
      } as unknown as import("@slack/bolt").App;
      const responder = new SlackResponder(app);

      // Start updateStatus (postMessage will hang then reject)
      const updatePromise = responder.updateStatus(
        "C123",
        "1234567890.123456",
        "Working...",
        "default",
      );

      // While updateStatus is in flight, call deleteStatus
      const deletePromise = responder.deleteStatus(
        "C123",
        "1234567890.123456",
        "default",
      );

      // Reject the in-flight postMessage
      rejectPost!(new Error("Slack API error"));

      // Both should resolve without throwing
      await Promise.all([
        updatePromise.catch(() => {}),
        deletePromise.catch(() => {}),
      ]);

      // No delete calls — postMessage failed, so no message to clean up
      const deleteCalls = calls.filter((c) => c.method === "delete");
      expect(deleteCalls).toHaveLength(0);
    });
  });

  describe("different agents on the same thread", () => {
    it("tracks status messages per agent without interference", async () => {
      const { app, calls } = mockApp({
        postMessageResults: [
          { ts: "status-ts-lead" },
          { ts: "status-ts-worker" },
        ],
      });
      const responder = new SlackResponder(app);

      // Two agents post status on the same thread
      await responder.updateStatus("C123", "1234567890.123456", "Lead thinking...", "lead");
      await responder.updateStatus("C123", "1234567890.123456", "Worker working...", "worker");

      expect(calls.postMessage).toHaveLength(2);
      expect(calls.postMessage[0].text).toBe("Lead thinking...");
      expect(calls.postMessage[1].text).toBe("Worker working...");

      // Deleting lead's status should not affect worker's
      await responder.deleteStatus("C123", "1234567890.123456", "lead");
      expect(calls.delete).toHaveLength(1);
      expect(calls.delete[0].ts).toBe("status-ts-lead");

      // Worker's status should still be deletable independently
      await responder.deleteStatus("C123", "1234567890.123456", "worker");
      expect(calls.delete).toHaveLength(2);
      expect(calls.delete[1].ts).toBe("status-ts-worker");
    });
  });

  describe("concurrent first-call updateStatus (coalescing)", () => {
    it("coalesces two concurrent first-call updateStatus into one post + one update", async () => {
      let resolveFirst: (value: unknown) => void;
      const firstPostPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const calls: Array<{ method: string; args: Record<string, unknown> }> =
        [];
      const app = {
        client: {
          chat: {
            postMessage: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "postMessage", args });
              // First call hangs; subsequent calls resolve immediately.
              if (calls.filter((c) => c.method === "postMessage").length === 1) {
                await firstPostPromise;
              }
              return { ts: "status-ts-concurrent" };
            }),
            delete: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "delete", args });
              return { ok: true };
            }),
            update: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "update", args });
              return { ok: true };
            }),
          },
          reactions: { add: vi.fn(async () => ({ ok: true })) },
        },
      } as unknown as import("@slack/bolt").App;
      const responder = new SlackResponder(app);

      // First updateStatus — its postMessage will hang
      const update1 = responder.updateStatus(
        "C123",
        "1234567890.123456",
        "Working...",
        "lead",
      );

      // While the first is in flight, a second updateStatus arrives.
      // It should coalesce: await the first post, then update the message.
      const update2 = responder.updateStatus(
        "C123",
        "1234567890.123456",
        "Still working...",
        "lead",
      );

      // Resolve the first postMessage — both calls can now proceed
      resolveFirst!({ ts: "status-ts-concurrent" });

      await Promise.all([update1, update2]);

      // Only ONE postMessage (the first call) — no orphan duplicate
      const postCalls = calls.filter((c) => c.method === "postMessage");
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].args.text).toBe("Working...");

      // The second call should have updated the message instead of posting a new one
      const updateCalls = calls.filter((c) => c.method === "update");
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args.text).toBe("Still working...");
      expect(updateCalls[0].args.ts).toBe("status-ts-concurrent");
    });

    it("coalesced update skips gracefully when deleteStatus claimed the pending post", async () => {
      let resolveFirst: (value: unknown) => void;
      const firstPostPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const calls: Array<{ method: string; args: Record<string, unknown> }> =
        [];
      const app = {
        client: {
          chat: {
            postMessage: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "postMessage", args });
              await firstPostPromise;
              return { ts: "status-ts-coalesce-del" };
            }),
            delete: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "delete", args });
              return { ok: true };
            }),
            update: vi.fn(async (args: Record<string, unknown>) => {
              calls.push({ method: "update", args });
              return { ok: true };
            }),
          },
          reactions: { add: vi.fn(async () => ({ ok: true })) },
        },
      } as unknown as import("@slack/bolt").App;
      const responder = new SlackResponder(app);

      // Start first updateStatus (postMessage hangs)
      const update1 = responder.updateStatus(
        "C123",
        "1234567890.123456",
        "Working...",
        "lead",
      );

      // Second updateStatus should coalesce (await pending)
      const update2 = responder.updateStatus(
        "C123",
        "1234567890.123456",
        "Still working...",
        "lead",
      );

      // deleteStatus claims the pending post while it's still in flight
      const deletePromise = responder.deleteStatus(
        "C123",
        "1234567890.123456",
        "lead",
      );

      // Now resolve the postMessage
      resolveFirst!({ ts: "status-ts-coalesce-del" });

      await Promise.all([update1, update2, deletePromise]);

      // First call: posted then superseded (deleteStatus claimed it)
      // Second call: coalesced, found no entry (deleted), skips
      // No update calls should have been made
      const updateCalls = calls.filter((c) => c.method === "update");
      expect(updateCalls).toHaveLength(0);

      // The inflight delete should have removed the posted message
      const deleteCalls = calls.filter((c) => c.method === "delete");
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args.ts).toBe("status-ts-coalesce-del");
    });
  });

  describe("debounce", () => {
    it("skips rapid status updates within 1 second", async () => {
      const { app, calls } = mockApp({
        postMessageResults: [{ ts: "status-ts-1" }],
      });
      const responder = new SlackResponder(app);

      await responder.updateStatus("C123", "1234567890.123456", "Update 1");

      // Second call within 1 second should be debounced (no update call)
      await responder.updateStatus("C123", "1234567890.123456", "Update 2");

      expect(calls.postMessage).toHaveLength(1);
      expect(calls.update).toHaveLength(0);
    });
  });

  describe("postResponse with optional iconEmoji", () => {
    it("includes icon_emoji when identity has iconEmoji set", async () => {
      const { app, calls } = mockApp();
      const responder = new SlackResponder(app);

      await responder.postResponse(
        "C123",
        "1234567890.123456",
        "Hello!",
        { username: "Reviewer", iconEmoji: ":eyes:" },
      );

      expect(calls.postMessage).toHaveLength(1);
      expect(calls.postMessage[0].username).toBe("Reviewer");
      expect(calls.postMessage[0].icon_emoji).toBe(":eyes:");
    });

    it("omits icon_emoji when identity has no iconEmoji (default agent)", async () => {
      const { app, calls } = mockApp();
      const responder = new SlackResponder(app);

      await responder.postResponse(
        "C123",
        "1234567890.123456",
        "Hello!",
        { username: "Junior" },
      );

      expect(calls.postMessage).toHaveLength(1);
      expect(calls.postMessage[0].username).toBe("Junior");
      expect(calls.postMessage[0].icon_emoji).toBeUndefined();
    });

    it("includes icon_url when identity has imageUrl set", async () => {
      const { app, calls } = mockApp();
      const responder = new SlackResponder(app);

      await responder.postResponse(
        "C123",
        "1234567890.123456",
        "Hello!",
        { username: "GitHub Access", imageUrl: "https://example.com/icon.png" },
      );

      expect(calls.postMessage).toHaveLength(1);
      expect(calls.postMessage[0].username).toBe("GitHub Access");
      expect(calls.postMessage[0].icon_url).toBe("https://example.com/icon.png");
      expect(calls.postMessage[0].icon_emoji).toBeUndefined();
    });

    it("renders action buttons on the first response chunk", async () => {
      const { app, calls } = mockApp({
        postMessageResults: [{ ts: "response-ts-1" }],
      });
      const responder = new SlackResponder(app);

      const posted = await responder.postResponse(
        "C123",
        "1234567890.123456",
        "review: changes-requested",
        { username: "Reviewer", iconEmoji: ":eyes:" },
        [
          { token: "tok-1", label: "Re-review", style: "primary" },
          { token: "tok-2", label: "Cleanup worktree" },
        ],
      );

      expect(posted).toEqual([
        { ts: "response-ts-1", text: "review: changes-requested" },
      ]);
      expect(calls.postMessage[0].blocks).toEqual([
        {
          type: "section",
          text: { type: "mrkdwn", text: "review: changes-requested" },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Re-review", emoji: true },
              action_id: "junior_agent_action",
              value: "tok-1",
              style: "primary",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Cleanup worktree", emoji: true },
              action_id: "junior_agent_action",
              value: "tok-2",
            },
          ],
        },
      ]);
    });

    it("caps the block-bearing chunk at Slack's 3000 char section limit", async () => {
      const { app, calls } = mockApp({
        postMessageResults: [{ ts: "response-ts-1" }, { ts: "response-ts-2" }],
      });
      const responder = new SlackResponder(app);
      const longText = "a".repeat(3_500);

      const posted = await responder.postResponse(
        "C123",
        "1234567890.123456",
        longText,
        undefined,
        [{ token: "tok-1", label: "Re-review" }],
      );

      expect(posted).toEqual([
        { ts: "response-ts-1", text: "a".repeat(3_000) },
        { ts: "response-ts-2", text: "a".repeat(500) },
      ]);
      expect(calls.postMessage).toHaveLength(2);
      expect(calls.postMessage[0].text).toHaveLength(3_000);
      expect(calls.postMessage[0].blocks?.[0]).toEqual({
        type: "section",
        text: { type: "mrkdwn", text: "a".repeat(3_000) },
      });
      expect(calls.postMessage[1].blocks).toBeUndefined();
    });
  });
});
