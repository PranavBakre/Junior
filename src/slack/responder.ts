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
   * In-flight `postMessage` promises for first-call status posts. Used for
   * two purposes:
   *
   * 1. **Coalescing:** When concurrent `updateStatus` calls both see no
   *    existing entry, the second awaits the first's in-flight post and
   *    updates the resulting message instead of creating a duplicate.
   *
   * 2. **Race guard:** When `deleteStatus` is called while a status
   *    `postMessage` is still in flight, it awaits the pending promise so
   *    it can find and delete the resulting message, preventing a duplicate
   *    alongside the final response.
   */
  private pendingStatusPosts = new Map<string, Promise<unknown>>();

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
        const message = {
          channel,
          thread_ts: threadTs,
          text: chunk,
          ...(identity
            ? {
                username: identity.username,
                ...(identity.iconEmoji ? { icon_emoji: identity.iconEmoji } : {}),
                ...(identity.imageUrl && !identity.iconEmoji
                  ? { icon_url: identity.imageUrl }
                  : {}),
              }
            : {}),
        };
        const result = await this.app.client.chat.postMessage(
          message as Parameters<typeof this.app.client.chat.postMessage>[0],
        );
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
      // If a first-call postMessage is already in flight for this key,
      // coalesce: await the pending post and update the resulting message
      // instead of creating a duplicate.
      const pending = this.pendingStatusPosts.get(key);
      if (pending) {
        try {
          const result = await pending;
          if (result && typeof result === "object" && "ts" in result && result.ts) {
            const entry = this.statusMessages.get(key);
            if (entry) {
              // The first post resolved and set a statusMessages entry.
              // Update it with the newer status text.
              try {
                await this.app.client.chat.update({
                  channel,
                  ts: entry.messageTs,
                  text,
                });
                entry.lastUpdateTime = Date.now();
                log.info(
                  "responder",
                  `status.coalesced thread=${threadTs} agent=${agentName} ts=${entry.messageTs} preview="${preview(text)}"`,
                );
              } catch (err) {
                log.error(
                  "responder",
                  `status.coalesce.update.fail thread=${threadTs} ts=${entry.messageTs} err=${err instanceof Error ? err.message : String(err)}`,
                );
              }
            } else {
              // Entry was removed (e.g., by deleteStatus claiming the pending
              // post). The message has been or will be deleted — skip.
              log.info(
                "responder",
                `status.coalesce.skip thread=${threadTs} agent=${agentName}`,
              );
            }
          }
        } catch {
          // The pending post failed — nothing to coalesce.
        }
        return;
      }

      // No in-flight first post — start a new one.
      const postPromise = this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
      });
      this.pendingStatusPosts.set(key, postPromise);

      try {
        const result = await postPromise;
        if (result.ts) {
          // If deleteStatus already claimed this pending post (removed it
          // from the map), the message has been or will be deleted — skip
          // adding to statusMessages to avoid a stale entry.
          if (!this.pendingStatusPosts.has(key)) {
            log.info(
              "responder",
              `status.superseded thread=${threadTs} agent=${agentName} ts=${result.ts}`,
            );
            return;
          }
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
      } finally {
        this.pendingStatusPosts.delete(key);
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

    // If a status postMessage is still in flight, await it so we can find
    // and delete the resulting message. Without this, deleteStatus runs as
    // a noop (the status map entry hasn't been set yet), and the in-flight
    // postMessage creates a stale status message alongside the final
    // response.
    const pending = this.pendingStatusPosts.get(key);
    if (pending) {
      // Claim the pending post: remove from map so updateStatus knows its
      // message will be deleted and skips adding a stale statusMessages entry.
      this.pendingStatusPosts.delete(key);
      try {
        const result = await pending;
        if (result && typeof result === "object" && "ts" in result && result.ts) {
          try {
            await this.app.client.chat.delete({ channel, ts: result.ts as string });
            log.info(
              "responder",
              `status.delete.inflight thread=${threadTs} agent=${agentName} ts=${result.ts as string}`,
            );
          } catch {
            // Best-effort delete; message may have already been removed.
          }
        }
      } catch {
        // postMessage failed — nothing to clean up.
      }
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

  /**
   * Drop in-memory status tracking for a thread after `!clear` removes bot
   * messages from Slack.
   */
  clearStatusForThread(threadTs: string): void {
    const prefix = `${threadTs}:`;
    for (const key of [...this.pendingStatusPosts.keys()]) {
      if (key.startsWith(prefix)) this.pendingStatusPosts.delete(key);
    }
    for (const key of [...this.statusMessages.keys()]) {
      if (key.startsWith(prefix)) this.statusMessages.delete(key);
    }
    log.info("responder", `status.clear.thread thread=${threadTs}`);
  }
}
