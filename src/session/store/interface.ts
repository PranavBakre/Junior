import type { AgentSession, ThreadSession } from "../types.ts";

export class SessionVersionConflictError extends Error {
  constructor(
    public threadId: string,
    public expectedVersion?: number,
  ) {
    super(`session version conflict for ${threadId}`);
    this.name = "SessionVersionConflictError";
  }
}

export interface SessionStore {
  get(threadId: string): Promise<ThreadSession | undefined>;
  set(threadId: string, session: ThreadSession): Promise<void>;
  delete(threadId: string): Promise<void>;
  getAll(): Promise<Map<string, ThreadSession>>;
  getRecent(sinceMs: number): Promise<Map<string, ThreadSession>>;
  updateActivity(threadId: string): Promise<void>;
  /**
   * Slack user IDs of additional admins beyond the env-var bootstrap admin.
   * Rule: one admin in `ADMIN_SLACK_USER_ID` (env), rest in the SQLite DB.
   * Memory store always returns empty.
   */
  extraAdmins(): Promise<Set<string>>;

  /**
   * Semantic per-thread mutation. Implementations MUST serialize per-thread
   * and use compare-and-set on `stateVersion`, retrying on conflict.
   * Throws if the session does not exist.
   */
  mutateThread(
    threadId: string,
    mutator: (
      session: ThreadSession,
    ) => ThreadSession | void | Promise<ThreadSession | void>,
  ): Promise<ThreadSession>;

  /**
   * Semantic per-agent mutation within a thread session. Same serialization
   * and CAS guarantees as mutateThread. Throws if the thread session or the
   * named agent session does not exist.
   */
  mutateAgent(
    threadId: string,
    agentName: string,
    mutator: (
      agent: AgentSession,
      session: ThreadSession,
    ) => AgentSession | void | Promise<AgentSession | void>,
  ): Promise<ThreadSession>;

  /**
   * Explicit per-agent row removal. Required because dual-write UPSERT no
   * longer deletes agents missing from a snapshot (concurrent-safe). Callers
   * that intend to drop an agent (e.g. !reset <agent>) must use this.
   */
  removeAgentSession(threadId: string, agentName: string): Promise<void>;
}
