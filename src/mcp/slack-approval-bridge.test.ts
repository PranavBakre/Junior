import { afterEach, describe, expect, it, mock } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { resolvePendingApproval } from "./approval.ts";
import {
  configureSlackApprovalBridge,
  requestSlackApproval,
} from "./slack-approval-bridge.ts";
import type { CreateSlackActionRecord, SlackActionStore } from "../slack/action-store.ts";

afterEach(() => {
  configureSlackApprovalBridge(undefined, undefined);
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
    await Bun.sleep(5);
    expect(rows).toHaveLength(2);
    const allow = rows.find((row) =>
      row.action.type === "request_permission" && row.action.decision === "allow"
    );
    expect(allow).toBeDefined();
    if (allow?.action.type !== "request_permission") throw new Error("missing allow action");
    expect(resolvePendingApproval(allow.action.approvalToken, "allow")).toBe(true);

    expect(await pending).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
