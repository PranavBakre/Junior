import { afterEach, describe, expect, it, mock } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { resolvePendingApproval } from "./approval.ts";
import {
  configureSlackApprovalBridge,
  requestSlackApproval,
} from "./slack-approval-bridge.ts";
import type { CreateSlackActionRecord, SlackActionStore } from "../slack/action-store.ts";

const originalApprovalTimeout = process.env.CLAUDE_APPROVAL_TIMEOUT_MS;

afterEach(() => {
  configureSlackApprovalBridge(undefined, undefined);
  if (originalApprovalTimeout === undefined) {
    delete process.env.CLAUDE_APPROVAL_TIMEOUT_MS;
  } else {
    process.env.CLAUDE_APPROVAL_TIMEOUT_MS = originalApprovalTimeout;
  }
});

describe("Slack approval bridge", () => {
  it("fails closed when Slack approval dependencies are unavailable", async () => {
    configureSlackApprovalBridge(undefined, undefined);
    expect(await requestSlackApproval({
      channel: "C01",
      threadTs: "1.2",
      agent: "db-executioner",
      toolName: "git fetch",
    })).toBe(false);
  });

  it("posts buttons and resolves an allowed Codex request", async () => {
    const rows: CreateSlackActionRecord[] = [];
    const store = {
      createMany: mock(async (records: CreateSlackActionRecord[]) => {
        rows.push(...records);
        const allow = records.find((row) =>
          row.action.type === "request_permission" && row.action.decision === "allow"
        );
        if (allow?.action.type !== "request_permission") {
          throw new Error("missing allow action");
        }
        expect(resolvePendingApproval(allow.action.approvalToken, "allow")).toBe(true);
      }),
    } as unknown as SlackActionStore;
    const postMessage = mock(async () => ({ ok: true, ts: "10.20" }));
    const client = { chat: { postMessage } } as unknown as WebClient;
    configureSlackApprovalBridge(client, store);

    const pending = requestSlackApproval({
      channel: "C01",
      threadTs: "1.2",
      agent: "db-executioner",
      toolName: "exec_command",
      input: { cmd: "git fetch" },
    });
    expect(await pending).toBe(true);
    expect(rows).toHaveLength(2);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("cleans up the pending resolver when action storage fails", async () => {
    let approvalToken = "";
    const store = {
      createMany: mock(async (records: CreateSlackActionRecord[]) => {
        const action = records[0]?.action;
        if (action?.type === "request_permission") approvalToken = action.approvalToken;
        throw new Error("store unavailable");
      }),
    } as unknown as SlackActionStore;
    const client = {
      chat: { postMessage: mock(async () => ({ ok: true, ts: "10.20" })) },
    } as unknown as WebClient;
    configureSlackApprovalBridge(client, store);

    expect(await requestSlackApproval({
      channel: "C01",
      threadTs: "1.2",
      agent: "default",
      toolName: "exec_command",
    })).toBe(false);
    expect(approvalToken).not.toBe("");
    expect(resolvePendingApproval(approvalToken, "allow")).toBe(false);
  });

  it("disables actions and removes buttons after default-deny timeout", async () => {
    process.env.CLAUDE_APPROVAL_TIMEOUT_MS = "5";
    const disableMessageActions = mock(async () => {});
    const store = {
      createMany: mock(async () => {}),
      disableMessageActions,
    } as unknown as SlackActionStore;
    const update = mock(async () => ({ ok: true }));
    const client = {
      chat: {
        postMessage: mock(async () => ({ ok: true, ts: "10.20" })),
        update,
      },
    } as unknown as WebClient;
    configureSlackApprovalBridge(client, store);

    expect(await requestSlackApproval({
      channel: "C01",
      threadTs: "1.2",
      agent: "default",
      toolName: "exec_command",
    })).toBe(false);
    expect(disableMessageActions).toHaveBeenCalledWith("C01", "10.20");
    expect(update).toHaveBeenCalledWith({
      channel: "C01",
      ts: "10.20",
      text: expect.any(String),
      blocks: [],
    });
  });
});
