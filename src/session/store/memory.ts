import type { ThreadSession } from "../types.ts";
import type { SessionStore } from "./interface.ts";

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, ThreadSession>();

  async get(threadId: string): Promise<ThreadSession | undefined> {
    return this.sessions.get(threadId);
  }

  async set(threadId: string, session: ThreadSession): Promise<void> {
    this.sessions.set(threadId, session);
  }

  async delete(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }

  async getAll(): Promise<Map<string, ThreadSession>> {
    return new Map(this.sessions);
  }

  async getRecent(sinceMs: number): Promise<Map<string, ThreadSession>> {
    const cutoff = Date.now() - sinceMs;
    const recent = new Map<string, ThreadSession>();
    for (const [threadId, session] of this.sessions) {
      if (session.lastActivity >= cutoff) {
        recent.set(threadId, session);
      }
    }
    return recent;
  }

  async updateActivity(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  async extraAdmins(): Promise<Set<string>> {
    return new Set();
  }
}
