import { describe, expect, it, mock } from "bun:test";
import type { App } from "@slack/bolt";
import { createSession } from "../session/types.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import { buildSessionDetailModal, publishHomeTab, registerHomeTab } from "./home.ts";

describe("publishHomeTab", () => {
  it("keeps home rows compact and moves resume details behind a button", async () => {
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
                view: {
                  blocks: Array<{
                    text?: { text?: string };
                    accessory?: { action_id?: string; value?: string };
                  }>;
                };
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

    expect(text).not.toContain("Resume: `opencode --session ses_123`");
    expect(text).not.toContain("opencode run --session ses_123");
    expect(blocks.some((block) => block.accessory?.action_id === "home_session_details" && block.accessory.value === session.threadId)).toBe(true);
    expect(blocks.every((block) => (block.text?.text?.length ?? 0) <= 3_000)).toBe(true);
  });

  it("opens a session detail modal from the home button", async () => {
    const session = createSession("1700000000.000001", "C123", "normal", "opencode");
    session.sessionId = "ses_123";
    session.agentSessions.thinker = {
      agentName: "thinker",
      provider: "opencode",
      sessionId: "ses_agent",
      status: "done",
      pendingMessages: [],
      lastActivity: Date.now(),
      pid: null,
    };

    const store = {
      get: mock(async () => session),
    } as unknown as SessionStore;
    const open = mock(async () => ({ ok: true }));
    let actionHandler: ((args: unknown) => Promise<void>) | undefined;
    const app = {
      event: mock(() => undefined),
      action: mock((_actionId: string, handler: typeof actionHandler) => {
        actionHandler = handler;
      }),
      client: { views: { open } },
    } as unknown as App;

    registerHomeTab(app, store, 1_000);
    await actionHandler!({
      ack: mock(async () => undefined),
      body: {
        trigger_id: "trigger_123",
        actions: [{ value: session.threadId }],
      },
      client: app.client,
    });

    const openCalls = (open as unknown as { mock: { calls: Array<[{ trigger_id: string; view: { blocks: Array<{ text: { text: string } }> } }]> } }).mock.calls;
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]![0].trigger_id).toBe("trigger_123");
    const modalText = openCalls[0]![0].view.blocks.map((block) => block.text.text).join("\n");
    expect(modalText).toContain("*Resume:*\n`opencode --session ses_123`");
    expect(modalText).toContain("Resume: `opencode --session ses_agent`");
    expect(openCalls[0]![0].view.blocks.every((block) => block.text.text.length <= 3_000)).toBe(true);
  });

  it("shows workflow state and recent artifacts", async () => {
    const store = {
      getRecent: mock(async () => new Map()),
    } as unknown as SessionStore;
    const workflowStore = {
      listStates: mock(async () => [{
        name: "worklog",
        status: "active",
        activeVersionHash: "abcdef1234567890",
        sourcePath: "workflows/worklog.workflow.md",
        lastLoadedAt: Date.now(),
        nextRunAt: Date.now() + 60_000,
        lastRunAt: Date.now() - 60_000,
        lastRunStatus: "success",
        lastError: null,
      }]),
      listRuns: mock(async () => [{
        id: "run-1",
        workflowName: "worklog",
        workflowVersionHash: "abcdef1234567890",
        sourcePath: "workflows/worklog.workflow.md",
        reason: "manual",
        actorSlackUserId: "U123",
        status: "success",
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now() - 30_000,
        artifactPath: "data/workflow-runs/worklog/run-1.md",
        providerSessionId: "ses-workflow",
        slackChannel: "C123",
        slackThreadTs: "123.456",
        error: null,
      }]),
    } as unknown as WorkflowStore;
    const publish = mock(async () => ({ ok: true }));
    const app = {
      client: {
        chat: {
          getPermalink: mock(async () => ({ permalink: "https://slack.example/thread" })),
        },
        views: { publish },
      },
    } as unknown as App;

    await publishHomeTab(app, "U123", store, 1_000, workflowStore);

    const publishCalls = (publish as unknown as { mock: { calls: Array<[{ view: { blocks: Array<{ text?: { text?: string } }> } }]> } }).mock.calls;
    const homeText = publishCalls[0]![0].view.blocks.map((block) => block.text?.text ?? "").join("\n");
    expect(homeText).toContain("*worklog*");
    expect(homeText).toContain("Active");
    expect(homeText).toContain("Last: success");
    expect(homeText).toContain("data/workflow-runs/worklog/run-1.md");
  });

  it("splits oversized modal text into Slack-safe blocks", () => {
    const session = createSession("1700000000.000001", "C123", "normal", "opencode");
    session.worktreePath = `/tmp/${"a".repeat(4_000)}`;

    const modal = buildSessionDetailModal(session) as { blocks: Array<{ text: { text: string } }> };
    expect(modal.blocks.length).toBeGreaterThan(1);
    expect(modal.blocks.every((block) => block.text.text.length <= 3_000)).toBe(true);
  });

  it("redacts prompt-leak errors from home and detail modal", async () => {
    const session = createSession("1700000000.000001", "C123", "normal", "opencode");
    session.lastError = {
      type: "ProviderError",
      message: "File not found: <identity>\n# SOUL.md — Junior\nYour Slack user ID is U0ABKQ4V065",
      timestamp: Date.now(),
    };
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

    const publishCalls = (publish as unknown as { mock: { calls: Array<[{ view: { blocks: Array<{ text?: { text?: string } }> } }]> } }).mock.calls;
    const homeText = publishCalls[0]![0].view.blocks.map((block) => block.text?.text ?? "").join("\n");
    const modal = buildSessionDetailModal(session) as { blocks: Array<{ text: { text: string } }> };
    const modalText = modal.blocks.map((block) => block.text.text).join("\n");

    for (const text of [homeText, modalText]) {
      expect(text).toContain("Raw error withheld");
      expect(text).not.toContain("<identity>");
      expect(text).not.toContain("SOUL.md");
      expect(text).not.toContain("Your Slack user ID");
    }
  });
});
