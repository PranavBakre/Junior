import type { Config } from "../config.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "../claude/types.ts";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { SessionStore } from "./store/interface.ts";
import type { ThreadSession } from "./types.ts";
import { createSession } from "./types.ts";
import { spawnClaude } from "../claude/spawner.ts";

export class SessionManager {
  private store: SessionStore;
  private config: Config;
  private handles = new Map<string, SpawnHandle>();

  onResponse?: (session: ThreadSession, response: string) => void;
  onEvent?: (session: ThreadSession, event: StreamEvent) => void;
  onMessageBuffered?: (event: SlackMessageEvent) => void;
  onError?: (session: ThreadSession, error: string | null) => void;

  constructor(store: SessionStore, config: Config) {
    this.store = store;
    this.config = config;
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    let session = await this.store.get(event.threadId);

    if (!session) {
      session = createSession(event.threadId, event.channel);
      await this.store.set(event.threadId, session);
    }

    if (session.status === "busy") {
      session.pendingMessages.push({
        user: event.user,
        text: event.text,
        ts: event.ts,
        command: event.command ?? undefined,
      });
      await this.store.set(session.threadId, session);
      this.onMessageBuffered?.(event);
      return;
    }

    session.status = "busy";
    session.lastActivity = Date.now();
    await this.store.set(session.threadId, session);

    this.runClaude(session, event.text);
  }

  async getSession(threadId: string): Promise<ThreadSession | undefined> {
    return this.store.get(threadId);
  }

  async resetSession(threadId: string): Promise<void> {
    const session = await this.store.get(threadId);
    if (session && session.status === "busy") {
      const handle = this.handles.get(threadId);
      if (handle) {
        handle.kill();
        this.handles.delete(threadId);
      }
    }
    await this.store.delete(threadId);
  }

  private runClaude(session: ThreadSession, prompt: string): void {
    const handle = spawnClaude(session, prompt, this.config.claude);
    this.handles.set(session.threadId, handle);
    session.pid = handle.pid;

    handle.onEvent((event) => {
      if (event.type === "system" && event.subtype === "init") {
        session.sessionId = event.session_id;
      }
      this.onEvent?.(session, event);
    });

    handle.result.then(
      (result) => this.onRunComplete(session, result),
      (err) => this.onRunComplete(session, {
        sessionId: null,
        response: "",
        events: [],
        exitCode: null,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  private async onRunComplete(
    session: ThreadSession,
    result: SpawnResult,
  ): Promise<void> {
    this.handles.delete(session.threadId);
    session.pid = null;

    if (result.sessionId) {
      session.sessionId = result.sessionId;
    }

    if (result.error) {
      session.lastError = {
        type: "spawn",
        message: result.error,
        timestamp: Date.now(),
      };
      this.onError?.(session, result.error);
    }

    this.onResponse?.(session, result.response);

    if (session.pendingMessages.length > 0) {
      const combined = session.pendingMessages
        .map((m) => `[${m.user}]: ${m.text}`)
        .join("\n");
      session.pendingMessages = [];
      session.status = "draining";
      await this.store.set(session.threadId, session);
      this.runClaude(session, combined);
    } else {
      session.status = "idle";
      await this.store.set(session.threadId, session);
    }
  }
}
