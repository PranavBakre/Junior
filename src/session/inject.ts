import type { SlackMessageEvent } from "../slack/events.ts";

export function toDashboardSlackEvent(input: {
  threadId: string;
  channel: string;
  prompt: string;
  actorSlackUserId: string;
  postedTs: string;
}): SlackMessageEvent {
  return {
    threadId: input.threadId,
    channel: input.channel,
    user: input.actorSlackUserId,
    attributionUserId: input.actorSlackUserId,
    text: input.prompt,
    conversationalText: input.prompt,
    ts: input.postedTs,
    command: null,
    isSelfBot: true,
    botUsername: "dashboard",
    dedupeKey: `dashboard:${input.threadId}:${input.postedTs}`,
    dashboardContinue: true,
  };
}
