import { describe, expect, it, mock } from "bun:test";
import type { App } from "@slack/bolt";
import { createSession } from "../session/types.ts";
import type { SessionStore } from "../session/store/interface.ts";
import { publishHomeTab } from "./home.ts";

describe("publishHomeTab", () => {
  it("shows the interactive OpenCode resume command", async () => {
    const session = createSession("1700000000.000001", "C123", "normal", "opencode");
    session.sessionId = "ses_123";

    const sessions = new Map([[session.threadId, session]]);
    const store = {
      getRecent: mock(async () => sessions),
    } as unknown as SessionStore;

    const publish = mock(async () => ({ ok: true }));
    const app = {
      client: {
        chat: {
          getPermalink: mock(async () => ({ permalink: "https://slack.example/thread" })),
        },
        views: { publish },
      },
    } as unknown as App;

    await publishHomeTab(app, "U123", store, 1_000);

    const publishCalls = (
      publish as unknown as {
        mock: {
          calls: Array<
            [
              {
                view: { blocks: Array<{ text?: { text?: string } }> };
              },
            ]
          >;
        };
      }
    ).mock.calls;
    expect(publishCalls).toHaveLength(1);
    const blocks = publishCalls[0]![0].view.blocks;
    const text = blocks
      .map((block) => block.text?.text ?? "")
      .join("\n");

    expect(text).toContain("Resume: `opencode --session ses_123`");
    expect(text).not.toContain("opencode run --session ses_123");
  });
});
