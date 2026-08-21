import type { WebClient } from "@slack/web-api";
import {
  cancelPendingApproval,
  registerPendingApproval,
} from "./approval.ts";
import type { SlackActionStore } from "../slack/action-store.ts";
import { buildActionBlocks } from "../slack/responder.ts";
import type { SlackActionButtonSpec } from "../slack/formatting.ts";

let slackClient: WebClient | undefined;
let actionStore: SlackActionStore | undefined;

export function configureSlackApprovalBridge(
  client: WebClient | undefined,
  store: SlackActionStore | undefined,
): void {
  slackClient = client;
  actionStore = store;
}

export async function requestSlackApproval(options: {
  channel: string;
  threadTs: string;
  agent: string;
  toolName: string;
  input?: unknown;
}): Promise<boolean> {
  if (!slackClient || !actionStore) return false;

  const approvalToken = crypto.randomUUID();
  const preview = renderInput(options.input);
  const text =
    `:lock: *Permission requested* by \`${options.agent}\`\n\`${options.toolName}\`` +
    (preview ? `\n${preview}` : "");
  const buttons: Array<{ action: SlackActionButtonSpec; token: string }> = [
    {
      action: {
        id: "permission-allow",
        label: "Allow",
        style: "primary",
        type: "request_permission",
        approvalToken,
        decision: "allow",
      },
      token: crypto.randomUUID(),
    },
    {
      action: {
        id: "permission-deny",
        label: "Deny",
        style: "danger",
        type: "request_permission",
        approvalToken,
        decision: "deny",
      },
      token: crypto.randomUUID(),
    },
  ];
  const blocks = buildActionBlocks(
    text,
    buttons.map(({ action, token }) => ({
      token,
      label: action.label,
      style: action.style,
    })),
  );
  // Register before the Slack message can become clickable. In particular,
  // createMany implementations may expose/resolve the actions synchronously.
  const pendingDecision = registerPendingApproval(approvalToken);
  try {
    const posted = await slackClient.chat.postMessage({
      channel: options.channel,
      thread_ts: options.threadTs,
      text,
      blocks,
    } as Parameters<WebClient["chat"]["postMessage"]>[0]);
    if (!posted.ts) {
      cancelPendingApproval(approvalToken);
      return false;
    }

    await actionStore.createMany(
      buttons.map(({ action, token }) => ({
        token,
        channelId: options.channel,
        threadTs: options.threadTs,
        messageTs: posted.ts!,
        messageText: text,
        action,
        sourceAgent: options.agent,
      })),
    );
    return (await pendingDecision) === "allow";
  } catch {
    cancelPendingApproval(approvalToken);
    return false;
  }
}

function renderInput(input: unknown): string {
  if (input === undefined) return "";
  let rendered: string;
  try {
    rendered = JSON.stringify(input, null, 2);
  } catch {
    rendered = String(input);
  }
  const bounded = rendered.length > 1_200
    ? `${rendered.slice(0, 1_197)}...`
    : rendered;
  return `\`\`\`\n${bounded.replace(/\`\`\`/g, "\` \` \`")}\n\`\`\``;
}
