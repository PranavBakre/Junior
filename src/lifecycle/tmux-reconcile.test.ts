import { describe, it, expect } from "bun:test";
import { reconcileTmuxSessions } from "./tmux-reconcile.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { createSession } from "../session/types.ts";
import type { TmuxDriver } from "../claude/tmux-driver.ts";

interface AdoptCall {
  threadId: string;
  agentName: string;
  cwd: string;
  tmuxSessionName: string;
  sessionId: string | null;
}

/**
 * Minimal fake TmuxDriver — just enough for reconcileTmuxSessions. Records
 * adoptExistingSession calls and answers tmuxHasSession from a live-set so
 * tests can simulate "tmux survived" vs "tmux died while bot was down."
 */
function fakeDriver(liveTmux: Set<string>): {
  driver: TmuxDriver;
  adoptCalls: AdoptCall[];
} {
  const adoptCalls: AdoptCall[] = [];
  const driver = {
    tmuxHasSession: async (name: string) => liveTmux.has(name),
    adoptExistingSession: async (input: AdoptCall) => {
      adoptCalls.push(input);
    },
  } as unknown as TmuxDriver;
  return { driver, adoptCalls };
}

describe("reconcileTmuxSessions", () => {
  it("adopts the top-level session using the row's topLevelTmuxAgent — not literal 'lead'", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    session.tmuxSessionName = "junior-T1-default";
    session.topLevelTmuxAgent = "default";
    session.worktreePath = "/tmp/T1";
    await store.set("T1", session);

    const { driver, adoptCalls } = fakeDriver(new Set(["junior-T1-default"]));
    const result = await reconcileTmuxSessions(store, driver);

    expect(result).toEqual({ adopted: 1, downgraded: 0 });
    expect(adoptCalls).toEqual([
      {
        threadId: "T1",
        agentName: "default",
        cwd: "/tmp/T1",
        tmuxSessionName: "junior-T1-default",
        sessionId: null,
      },
    ]);
  });

  it("downgrades a row whose tmux died while the bot was down", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    session.tmuxSessionName = "junior-T1-default";
    session.topLevelTmuxAgent = "default";
    session.worktreePath = "/tmp/T1";
    session.status = "busy";
    await store.set("T1", session);

    const { driver, adoptCalls } = fakeDriver(new Set()); // tmux gone
    const result = await reconcileTmuxSessions(store, driver);

    expect(result).toEqual({ adopted: 0, downgraded: 1 });
    expect(adoptCalls).toEqual([]);
    const after = (await store.get("T1"))!;
    expect(after.tmuxSessionName).toBeNull();
    expect(after.status).toBe("idle");
    expect(after.lastError?.type).toBe("tmux-lost");
  });

  it("resets status busy→idle when the bot died mid-turn but tmux survived", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    session.tmuxSessionName = "junior-T1-lead";
    session.topLevelTmuxAgent = "lead";
    session.worktreePath = "/tmp/T1";
    session.status = "busy";
    await store.set("T1", session);

    const { driver } = fakeDriver(new Set(["junior-T1-lead"]));
    const result = await reconcileTmuxSessions(store, driver);

    expect(result.adopted).toBe(1);
    const after = (await store.get("T1"))!;
    expect(after.status).toBe("idle");
    expect(after.lastError?.type).toBe("tmux-adopted-mid-turn");
  });

  it("skips sessions whose driverMode is not tmux", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "headless");
    session.worktreePath = "/tmp/T1";
    await store.set("T1", session);

    const { driver, adoptCalls } = fakeDriver(new Set());
    const result = await reconcileTmuxSessions(store, driver);

    expect(result).toEqual({ adopted: 0, downgraded: 0 });
    expect(adoptCalls).toEqual([]);
  });

  it("walks per-agent tmux sessions independently of the top-level one", async () => {
    const store = new InMemorySessionStore();
    const session = createSession("T1", "C1", "quiet", "tmux");
    session.tmuxSessionName = "junior-T1-default";
    session.topLevelTmuxAgent = "default";
    session.worktreePath = "/tmp/T1";
    session.agentSessions = {
      reviewer: {
        agentName: "reviewer",
        sessionId: "rev-1",
        status: "idle",
        pendingMessages: [],
        lastActivity: Date.now(),
        pid: null,
        tmuxSessionName: "junior-T1-reviewer",
      },
    };
    await store.set("T1", session);

    const { driver, adoptCalls } = fakeDriver(
      new Set(["junior-T1-default", "junior-T1-reviewer"]),
    );
    const result = await reconcileTmuxSessions(store, driver);

    expect(result.adopted).toBe(2);
    const adoptedAgents = adoptCalls.map((c) => c.agentName).sort();
    expect(adoptedAgents).toEqual(["default", "reviewer"]);
  });
});
