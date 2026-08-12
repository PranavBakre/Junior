import { describe, expect, it } from "bun:test";
import { InMemorySessionStore } from "../../session/store/memory.ts";
import { createSession } from "../../session/types.ts";
import { handleSessionDetail } from "./sessions.ts";

describe("handleSessionDetail", () => {
  it("includes the resolved Slack thread permalink", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("1712345678.123456", "C123");
    await store.set(session.threadId, session);

    const response = await handleSessionDetail(
      store,
      session.threadId,
      async (channel, messageTs) => {
        expect(channel).toBe("C123");
        expect(messageTs).toBe("1712345678.123456");
        return "https://example.slack.com/archives/C123/p1712345678123456";
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      slackPermalink: "https://example.slack.com/archives/C123/p1712345678123456",
    });
  });

  it("keeps session detail available when Slack permalink resolution fails", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("1712345678.123456", "C123");
    await store.set(session.threadId, session);

    const response = await handleSessionDetail(
      store,
      session.threadId,
      async () => {
        throw new Error("Slack unavailable");
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session: { threadId: session.threadId },
      slackPermalink: null,
    });
  });
});
