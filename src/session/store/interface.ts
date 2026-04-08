import type { ThreadSession } from "../types.ts";

export interface SessionStore {
  get(threadId: string): Promise<ThreadSession | undefined>;
  set(threadId: string, session: ThreadSession): Promise<void>;
  delete(threadId: string): Promise<void>;
  getAll(): Promise<Map<string, ThreadSession>>;
  updateActivity(threadId: string): Promise<void>;
}
