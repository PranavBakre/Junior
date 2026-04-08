import type { Config } from "../config.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "../claude/types.ts";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { SessionStore } from "./store/interface.ts";
import type { ThreadSession } from "./types.ts";
import type { AgentRouter } from "../agents/router.ts";
import { createSession } from "./types.ts";
import { spawnClaude } from "../claude/spawner.ts";

export class SessionManager {
  private store: SessionStore;
  private config: Config;
  private handles = new Map<string, SpawnHandle>();

  agentRouter?: AgentRouter;
  onResponse?: (session: ThreadSession, response: string) => void;
  onEvent?: (session: ThreadSession, event: StreamEvent) => void;
  onMessageBuffered?: (event: SlackMessageEvent) => void;
  onError?: (session: ThreadSession, error: string | null) => void;
  onCommandResponse?: (event: SlackMessageEvent, response: string) => void;

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

    if (event.command) {
      const handled = await this.handleCommand(session, event);
      if (handled) return;
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

    this.runClaudeWithAgent(session, event.text);
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

  private async handleCommand(
    session: ThreadSession,
    event: SlackMessageEvent,
  ): Promise<boolean> {
    switch (event.command) {
      case "reset": {
        await this.resetSession(session.threadId);
        this.onCommandResponse?.(event, "Session reset.");
        return true;
      }

      case "status": {
        const ago = session.lastActivity
          ? `${Math.round((Date.now() - session.lastActivity) / 1000)}s ago`
          : "never";
        const lines = [
          `*Status:* ${session.status}`,
          `*Agent:* ${session.agentType ?? "default"}`,
          `*Repo:* ${session.targetRepo ?? "none"}`,
          `*Worktree:* ${session.worktreePath ?? "none"}`,
          `*Last activity:* ${ago}`,
          `*Pending messages:* ${session.pendingMessages.length}`,
        ];
        this.onCommandResponse?.(event, lines.join("\n"));
        return true;
      }

      case "help": {
        const helpText = [
          "*Commands:*",
          "`!build` — Build agent (continues to Claude)",
          "`!frontend` — Frontend agent (continues to Claude)",
          "`!review` — Review agent (continues to Claude)",
          "`!architect` — Architect agent (continues to Claude)",
          "`!repo <name>` — Set target repository",
          "`!branch <ref>` — Set base branch ref",
          "`!reset` — Reset session",
          "`!status` — Show session status",
          "`!quiet` — Minimal output",
          "`!normal` — Normal output",
          "`!verbose` — Verbose output",
          "`!help` — Show this help",
        ].join("\n");
        this.onCommandResponse?.(event, helpText);
        return true;
      }

      case "quiet": {
        session.verbosity = "quiet";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Quiet mode.");
        return true;
      }

      case "verbose": {
        session.verbosity = "verbose";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Verbose mode.");
        return true;
      }

      case "normal": {
        session.verbosity = "normal";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Normal mode.");
        return true;
      }

      case "build":
      case "frontend":
      case "review":
      case "architect": {
        session.agentType = event.command;
        await this.store.set(session.threadId, session);
        return false;
      }

      case "repo": {
        const repoName = event.text.trim();
        const match = this.config.repos.find((r) => r.name === repoName);
        if (match) {
          session.targetRepo = match.name;
          await this.store.set(session.threadId, session);
          this.onCommandResponse?.(event, `Repository set to *${match.name}*.`);
        } else {
          const available = this.config.repos.map((r) => r.name).join(", ");
          this.onCommandResponse?.(
            event,
            `Unknown repo "${repoName}". Available: ${available || "none configured"}`,
          );
        }
        return true;
      }

      case "branch": {
        const ref = event.text.trim();
        session.baseRef = ref;
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, `Base ref set to *${ref}*.`);
        return true;
      }

      default:
        return false;
    }
  }

  private async runClaudeWithAgent(
    session: ThreadSession,
    prompt: string,
  ): Promise<void> {
    if (session.agentType && this.agentRouter) {
      session.systemPrompt =
        (await this.agentRouter.composeSystemPrompt(session)) ?? null;
      await this.store.set(session.threadId, session);
    }

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
      this.runClaudeWithAgent(session, combined);
    } else {
      session.status = "idle";
      await this.store.set(session.threadId, session);
    }
  }
}
