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
  });
});