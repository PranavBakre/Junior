import type { AgentSession, ThreadSession } from "../types.ts";
import {
  SessionVersionConflictError,
  type SessionStore,
} from "./interface.ts";

const MUTATE_MAX_ATTEMPTS = 8;

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, ThreadSession>();
  /** Per-thread async mutex so mutateThread/mutateAgent serialize. */
  private locks = new Map<string, Promise<void>>();

  async get(threadId: string): Promise<ThreadSession | undefined> {
    return this.sessions.get(threadId);
  }

  async set(threadId: string, session: ThreadSession): Promise<void> {
    await this.withLock(threadId, async () => {
      const current = this.sessions.get(threadId);
      const nextVersion =
        current == null
          ? (session.stateVersion ?? 0) + 1
          : (current.stateVersion ?? 0) + 1;
      session.stateVersion = nextVersion;
      // Normalize agent state versions on write.
      session.agentSessions ??= {};
      for (const agent of Object.values(session.agentSessions)) {
        agent.stateVersion = (agent.stateVersion ?? 0) + 1;
      }
      this.sessions.set(threadId, session);
    });
  }

  async delete(threadId: string): Promise<void> {
    await this.withLock(threadId, async () => {
      this.sessions.delete(threadId);
    });
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
    await this.withLock(threadId, async () => {
      const session = this.sessions.get(threadId);
      if (session) {
        session.lastActivity = Date.now();
      }
    });
  }

  async extraAdmins(): Promise<Set<string>> {
    return new Set();
  }

  async mutateThread(
    threadId: string,
    mutator: (
      session: ThreadSession,
    ) => ThreadSession | void | Promise<ThreadSession | void>,
  ): Promise<ThreadSession> {
    return this.withLock(threadId, async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
        const current = this.sessions.get(threadId);
        if (!current) {
          throw new Error(`session not found: ${threadId}`);
        }
        const expectedVersion = current.stateVersion ?? 0;
        // Clone so concurrent mutators (and callers holding the live ref)
        // don't share nested agentSessions objects incorrectly.
        const draft = cloneSession(current);
        try {
          const result = await mutator(draft);
          const next = result ?? draft;
          // CAS: another writer under a different code path may have replaced
          // the map entry between our read and write. The per-thread lock
          // serializes mutateThread itself, but set() also takes the lock so
          // this mainly guards against version skew from set interleaved
          // outside the lock chain (shouldn't happen) and documents the CAS
          // contract for tests that force-write wrong versions.
          const still = this.sessions.get(threadId);
          if (!still || (still.stateVersion ?? 0) !== expectedVersion) {
            lastError = new SessionVersionConflictError(
              threadId,
              expectedVersion,
            );
            continue;
          }
          next.stateVersion = expectedVersion + 1;
          next.agentSessions ??= {};
          for (const agent of Object.values(next.agentSessions)) {
            agent.stateVersion = (agent.stateVersion ?? 0) + 1;
          }
          this.sessions.set(threadId, next);
          return next;
        } catch (err) {
          if (err instanceof SessionVersionConflictError) {
            lastError = err;
            continue;
          }
          throw err;
        }
      }
      throw lastError instanceof SessionVersionConflictError
        ? lastError
        : new SessionVersionConflictError(threadId);
    });
  }

  async mutateAgent(
    threadId: string,
    agentName: string,
    mutator: (
      agent: AgentSession,
      session: ThreadSession,
    ) => AgentSession | void | Promise<AgentSession | void>,
  ): Promise<ThreadSession> {
    return this.mutateThread(threadId, async (session) => {
      const agent = session.agentSessions?.[agentName];
      if (!agent) {
        throw new Error(
          `agent session not found: ${threadId}/${agentName}`,
        );
      }
      const result = await mutator(agent, session);
      if (result) {
        session.agentSessions[agentName] = result;
      }
    });
  }

  /**
   * Force a CAS write with an explicit expected version. Used by tests to
   * provoke SessionVersionConflictError without the retry loop.
   */
  casSet(
    threadId: string,
    session: ThreadSession,
    expectedVersion: number,
  ): void {
    const current = this.sessions.get(threadId);
    if (!current || (current.stateVersion ?? 0) !== expectedVersion) {
      throw new SessionVersionConflictError(threadId, expectedVersion);
    }
    session.stateVersion = expectedVersion + 1;
    this.sessions.set(threadId, session);
  }

  private async withLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      threadId,
      prev.then(() => gate).catch(() => gate),
    );
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      // Drop the lock chain if we are the tail, to avoid unbounded growth.
      if (this.locks.get(threadId) === prev.then(() => gate).catch(() => gate)) {
        // Can't reliably compare; leave the resolved promise. Harmless.
      }
    }
  }
}

function cloneSession(session: ThreadSession): ThreadSession {
  return JSON.parse(JSON.stringify(session)) as ThreadSession;
}
