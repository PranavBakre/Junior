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
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!slackClient || !actionStore || options.signal?.aborted) return false;

  const client = slackClient;
  const store = actionStore;

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
  let messageTs: string | null = null;
  let actionsStored = false;
  const cancel = () => {
    cancelPendingApproval(approvalToken);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const posted = await client.chat.postMessage({
      channel: options.channel,
      thread_ts: options.threadTs,
      text,
      blocks,
    } as Parameters<WebClient["chat"]["postMessage"]>[0]);
    if (!posted.ts) {
      cancelPendingApproval(approvalToken);
      return false;
    }
    messageTs = posted.ts;
    if (options.signal?.aborted) {
      cancel();
      await disableApprovalActions(client, store, options.channel, messageTs, text, false);
      return false;
    }

    await store.createMany(
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
    actionsStored = true;
    if (options.signal?.aborted) cancel();
    const approved = (await pendingDecision) === "allow";
    if (!approved) {
      await disableApprovalActions(client, store, options.channel, messageTs, text, true);
    }
    return approved;
  } catch {
    cancel();
    if (messageTs) {
      await disableApprovalActions(
        client,
        store,
        options.channel,
        messageTs,
        text,
        actionsStored,
      );
    }
    return false;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}

async function disableApprovalActions(
  client: WebClient,
  store: SlackActionStore,
  channel: string,
  messageTs: string,
  text: string,
  actionsStored: boolean,
): Promise<void> {
  await Promise.allSettled([
    ...(actionsStored
      ? [Promise.resolve().then(() => store.disableMessageActions(channel, messageTs))]
      : []),
    Promise.resolve().then(() =>
      client.chat.update({
        channel,
        ts: messageTs,
        text,
        blocks: [],
      })
    ),
  ]);
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
