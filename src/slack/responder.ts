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
  /**
   * Keys for which the final response has already been posted. Prevents a
   * race where an in-flight `updateStatus` completes *after* `deleteStatus`
   * ran as a noop (because the status map entry hadn't been set yet) and
   * posts a duplicate message alongside the final response.
   */
  private completed = new Set<string>();

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
            ? {
                username: identity.username,
                ...(identity.iconEmoji ? { icon_emoji: identity.iconEmoji } : {}),
              }
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
      // Race guard: if the final response has already been posted for this
      // thread/agent, the in-flight status update is stale. Skip posting
      // and, if the completed flag is set, delete any status message that
      // slipped through.
      if (this.completed.has(key)) {
        log.info(
          "responder",
          `status.skip thread=${threadTs} agent=${agentName} reason=response-already-posted`,
        );
        return;
      }

      // First call: post a new status message
      try {
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
        });
        if (result.ts) {
          // Double-check: final response may have been posted while we
          // were in flight. If so, delete the stale status message.
          if (this.completed.has(key)) {
            try {
              await this.app.client.chat.delete({ channel, ts: result.ts });
              log.info(
                "responder",
                `status.retract thread=${threadTs} agent=${agentName} ts=${result.ts} reason=response-posted-while-inflight`,
              );
            } catch {
              // Best-effort delete; message may have already been removed
            }
            return;
          }
          this.statusMessages.set(key, {
            messageTs: result.ts,
            lastUpdateTime: Date.now(),
          });
          // New status message created — clear any stale completed flag so
          // subsequent edits within the same turn are not blocked.
          this.completed.delete(key);
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

    // Mark this thread/agent as completed so that any in-flight updateStatus
    // call knows not to post a duplicate after the final response lands.
    this.completed.add(key);
    // Prevent unbounded growth — completed flags are short-lived but guard
    // against a leak if threads accumulate without status updates.
    if (this.completed.size > 1000) {
      const entries = [...this.completed];
      for (let i = 0; i < 500; i++) this.completed.delete(entries[i]);
    }

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
