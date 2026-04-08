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

  async updateActivity(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }
}
