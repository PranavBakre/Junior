import type { App } from "@slack/bolt";
import type { AgentIdentity } from "../session/types.ts";
import { splitResponse } from "./formatting.ts";
import { log } from "../logger.ts";

interface StatusEntry {
  messageTs: string;
  lastUpdateTime: number;
}

function preview(text: string, n = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

export class SlackResponder {
  private app: App;
  private statusMessages = new Map<string, StatusEntry>();

  constructor(app: App) {
    this.app = app;
  }

  async postResponse(
    channel: string,
    threadTs: string,
    text: string,
    identity?: AgentIdentity,
  ): Promise<void> {
    const chunks = splitResponse(text);
    log.info(
      "responder",
      `post.start thread=${threadTs} channel=${channel} chunks=${chunks.length} len=${text.length}`,
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: chunk,
          ...(identity
            ? { username: identity.username, icon_emoji: identity.iconEmoji }
            : {}),
        });
        log.info(
          "responder",
          `post.ok thread=${threadTs} chunk=${i + 1}/${chunks.length} ts=${result.ts ?? "?"} preview="${preview(chunk)}"`,
        );
      } catch (err) {
        log.error(
          "responder",
          `post.fail thread=${threadTs} chunk=${i + 1}/${chunks.length} err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async updateStatus(
    channel: string,
    threadTs: string,
    text: string,
    agentName: string = "lead",
  ): Promise<void> {
    const key = this.statusKey(threadTs, agentName);
    const existing = this.statusMessages.get(key);

    if (!existing) {
      // First call: post a new status message
      try {
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
        });
        if (result.ts) {
          this.statusMessages.set(key, {
            messageTs: result.ts,
            lastUpdateTime: Date.now(),
          });
          log.info(
            "responder",
            `status.post thread=${threadTs} agent=${agentName} ts=${result.ts} preview="${preview(text)}"`,
          );
        }
      } catch (err) {
        log.error(
          "responder",
          `status.post.fail thread=${threadTs} err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // Debounce: skip if less than 1 second since last update
    const now = Date.now();
    if (now - existing.lastUpdateTime < 1000) {
      log.info(
        "responder",
        `status.debounce thread=${threadTs} agent=${agentName} ts=${existing.messageTs}`,
      );
      return;
    }

    try {
      await this.app.client.chat.update({
        channel,
        ts: existing.messageTs,
        text,
      });
      existing.lastUpdateTime = now;
      log.info(
        "responder",
        `status.update thread=${threadTs} agent=${agentName} ts=${existing.messageTs} preview="${preview(text)}"`,
      );
    } catch (err) {
      log.error(
        "responder",
        `status.update.fail thread=${threadTs} ts=${existing.messageTs} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async deleteStatus(
    channel: string,
    threadTs: string,
    agentName: string = "lead",
  ): Promise<void> {
    const key = this.statusKey(threadTs, agentName);
    const existing = this.statusMessages.get(key);
    if (!existing) {
      log.info(
        "responder",
        `status.delete.noop thread=${threadTs} agent=${agentName}`,
      );
      return;
    }

    try {
      await this.app.client.chat.delete({
        channel,
        ts: existing.messageTs,
      });
      log.info(
        "responder",
        `status.delete thread=${threadTs} agent=${agentName} ts=${existing.messageTs}`,
      );
    } catch (err) {
      log.error(
        "responder",
        `status.delete.fail thread=${threadTs} ts=${existing.messageTs} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.statusMessages.delete(key);
  }

  async addReaction(
    channel: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    try {
      await this.app.client.reactions.add({
        channel,
        timestamp: messageTs,
        name: emoji,
      });
      log.info(
        "responder",
        `reaction.add channel=${channel} ts=${messageTs} emoji=${emoji}`,
      );
    } catch (err) {
      log.error(
        "responder",
        `reaction.add.fail channel=${channel} ts=${messageTs} emoji=${emoji} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private statusKey(threadTs: string, agentName: string): string {
    return `${threadTs}:${agentName}`;
  }
}
