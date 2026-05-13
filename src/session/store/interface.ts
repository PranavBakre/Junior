import type { ThreadSession } from "../types.ts";

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
}
