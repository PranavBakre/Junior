import type { App } from "@slack/bolt";
import { splitResponse } from "./formatting.ts";

interface StatusEntry {
  messageTs: string;
  lastUpdateTime: number;
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
  ): Promise<void> {
    const chunks = splitResponse(text);
    for (const chunk of chunks) {
      try {
        await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: chunk,
        });
      } catch (err) {
        console.error("[responder] Failed to post message:", err);
      }
    }
  }

  async updateStatus(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    const existing = this.statusMessages.get(threadTs);

    if (!existing) {
      // First call: post a new status message
      try {
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
        });
        if (result.ts) {
          this.statusMessages.set(threadTs, {
            messageTs: result.ts,
            lastUpdateTime: Date.now(),
          });
        }
      } catch (err) {
        console.error("[responder] Failed to post status:", err);
      }
      return;
    }

    // Debounce: skip if less than 1 second since last update
    const now = Date.now();
    if (now - existing.lastUpdateTime < 1000) {
      return;
    }

    try {
      await this.app.client.chat.update({
        channel,
        ts: existing.messageTs,
        text,
      });
      existing.lastUpdateTime = now;
    } catch (err) {
      console.error("[responder] Failed to update status:", err);
    }
  }

  async deleteStatus(channel: string, threadTs: string): Promise<void> {
    const existing = this.statusMessages.get(threadTs);
    if (!existing) return;

    try {
      await this.app.client.chat.delete({
        channel,
        ts: existing.messageTs,
      });
    } catch (err) {
      console.error("[responder] Failed to delete status:", err);
    }

    this.statusMessages.delete(threadTs);
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
    } catch (err) {
      console.error("[responder] Failed to add reaction:", err);
    }
  }
}
