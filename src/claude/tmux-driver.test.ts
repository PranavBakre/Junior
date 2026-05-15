import { describe, it, expect } from "bun:test";
import { tmuxSessionNameFor, TmuxDriver } from "./tmux-driver.ts";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadSession } from "../session/types.ts";
import type { Config } from "../config.ts";

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: "T-thread1",
    channel: "C01",
    sessionId: null,
    leadSessionId: null,
    agentSessions: {},
    worktreePath: null,
    worktreePaths: {},
    targetRepo: null,
    baseRef: null,
    agentType: null,
    systemPrompt: null,
    status: "idle",
    pendingMessages: [],
    verbosity: "normal",
    muted: false,
    model: null,
    cwd: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    driverMode: "tmux",
    tmuxSessionName: null,
    topLevelTmuxAgent: null,
    dormant: false,
    dormantAnnounced: false,
    humanParticipants: [],
    ...overrides,
  };
}

function claudeConfig(): Config["claude"] {
  return {
    maxTurns: 25,
    timeoutMs: 300_000,
    permissionMode: "bypassPermissions",
    defaultModel: null,
    defaultDriver: "tmux",
    tmuxIdleTtlMs: 14_400_000,
    tmuxSweepIntervalMs: 900_000,
  };
}

describe("tmuxSessionNameFor", () => {
  it("is deterministic for the same (threadId, agentName)", () => {
    const a = tmuxSessionNameFor("T01", "lead");
    const b = tmuxSessionNameFor("T01", "lead");
    expect(a).toBe(b);
    expect(a).toBe("junior-T01-lead");
  });

  it("differs per agent within the same thread (multi-agent safety)", () => {
    const lead = tmuxSessionNameFor("T01", "lead");
    const reproducer = tmuxSessionNameFor("T01", "reproducer");
    const thinker = tmuxSessionNameFor("T01", "thinker");
    expect(new Set([lead, reproducer, thinker]).size).toBe(3);
  });

  it("differs per thread for the same agent", () => {
    const a = tmuxSessionNameFor("T01", "lead");
    const b = tmuxSessionNameFor("T02", "lead");
    expect(a).not.toBe(b);
  });

  it("sanitizes characters tmux disallows", () => {
    const name = tmuxSessionNameFor("T 01.with:bad/chars", "lead");
    expect(name).not.toContain(".");
    expect(name).not.toContain(":");
    expect(name).not.toMatch(/\s/);
    expect(name).not.toContain("/");
  });

  it("clamps to tmux's 200-char limit", () => {
    const long = "x".repeat(500);
    const name = tmuxSessionNameFor(long, "lead");
    expect(name.length).toBeLessThanOrEqual(200);
  });
});

describe("TmuxDriver with stubbed exec", () => {
  function setup() {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const projectsRoot = mkdtempSync(join(tmpdir(), "junior-tmux-test-"));
    const liveSessions = new Set<string>();
    const driver = new TmuxDriver({
      projectsRoot,
      tmuxBin: "tmux",
      exec: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === "new-session") {
          const s = args.indexOf("-s");
          if (s >= 0) liveSessions.add(args[s + 1]);
        }
        if (args[0] === "kill-session") {
          const t = args.indexOf("-t");
          if (t >= 0) liveSessions.delete(args[t + 1]);
        }
        if (args[0] === "has-session") {
          const t = args.indexOf("-t");
          if (t >= 0 && !liveSessions.has(args[t + 1])) {
            throw new Error("no session");
          }
        }
        return "";
      },
    });
    return { driver, calls, projectsRoot, liveSessions };
  }

  it("starts a tmux session on first send and reuses it on second", async () => {
    const { driver, calls } = setup();
    const cwd = mkdtempSync(join(tmpdir(), "junior-cwd-"));
    const session = makeSession({ worktreePath: cwd });

    const handle1 = driver.send({
      session,
      prompt: "hello",
      config: claudeConfig(),
      threadId: session.threadId,
      agentName: "lead",
    });
    // Don't await result — the transcript-tail loop wouldn't resolve in a test
    // without a real claude. We only verify the side effects of ensureSession.
    await new Promise((r) => setTimeout(r, 50));
    handle1.kill();

    const startCalls = calls.filter((c) => c.args[0] === "new-session");
    expect(startCalls.length).toBe(1);
    const sessName = startCalls[0].args[startCalls[0].args.indexOf("-s") + 1];
    expect(sessName).toBe(tmuxSessionNameFor(session.threadId, "lead"));

    const handle2 = driver.send({
      session,
      prompt: "second",
      config: claudeConfig(),
      threadId: session.threadId,
      agentName: "lead",
    });
    await new Promise((r) => setTimeout(r, 50));
    handle2.kill();

    // Same session — no second new-session call.
    expect(calls.filter((c) => c.args[0] === "new-session").length).toBe(1);
  });

  it("close() invokes kill-session for that (thread, agent)", async () => {
    const { driver, calls } = setup();
    const cwd = mkdtempSync(join(tmpdir(), "junior-cwd-"));
    const session = makeSession({ worktreePath: cwd });
    const h = driver.send({
      session,
      prompt: "x",
      config: claudeConfig(),
      threadId: session.threadId,
      agentName: "lead",
    });
    await new Promise((r) => setTimeout(r, 30));
    h.kill();
    await driver.close(session.threadId, "lead");
    const killCalls = calls.filter((c) => c.args[0] === "kill-session");
    expect(killCalls.length).toBe(1);
    expect(killCalls[0].args).toContain(tmuxSessionNameFor(session.threadId, "lead"));
  });

  it("isolates per (thread, agent) — same thread, two agents → two tmux sessions", async () => {
    const { driver, calls } = setup();
    const cwd = mkdtempSync(join(tmpdir(), "junior-cwd-"));
    const session = makeSession({ worktreePath: cwd });

    // Issue sequentially — the manager guarantees this via `status: busy`
    // gates on the parent session row. We only need to verify the driver
    // doesn't collapse different keys onto one tmux session.
    const h1 = driver.send({
      session,
      prompt: "for lead",
      config: claudeConfig(),
      threadId: session.threadId,
      agentName: "lead",
    });
    await new Promise((r) => setTimeout(r, 80));
    const h2 = driver.send({
      session,
      prompt: "for thinker",
      config: claudeConfig(),
      threadId: session.threadId,
      agentName: "thinker",
    });
    await new Promise((r) => setTimeout(r, 80));
    h1.kill();
    h2.kill();

    const newSessions = calls
      .filter((c) => c.args[0] === "new-session")
      .map((c) => c.args[c.args.indexOf("-s") + 1]);
    expect(new Set(newSessions).size).toBe(2);
    expect(newSessions).toContain(tmuxSessionNameFor(session.threadId, "lead"));
    expect(newSessions).toContain(tmuxSessionNameFor(session.threadId, "thinker"));
  });

  it("resolves a turn off system.turn_duration in the transcript", async () => {
    const { driver, projectsRoot } = setup();
    const cwd = mkdtempSync(join(tmpdir(), "junior-cwd-"));
    const session = makeSession({ worktreePath: cwd });

    // Pre-create the transcript file so the driver finds it on first scan.
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = join(projectsRoot, encodedCwd);
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "deadbeef-cafe-1234-5678-9abcdef01234";
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

    const handle = driver.send({
      session,
      prompt: "hi",
      config: claudeConfig(),
      threadId: session.threadId,
      agentName: "lead",
    });

    // Write assistant + turn_duration lines after the send is queued.
    await new Promise((r) => setTimeout(r, 100));
    const assistant = JSON.stringify({
      type: "assistant",
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ack" }],
      },
    });
    const turnDone = JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      durationMs: 50,
      messageCount: 1,
      sessionId,
    });
    writeFileSync(transcriptPath, assistant + "\n" + turnDone + "\n");

    // Wait for fs.watch to fire (macOS can be slow); cap at 3s.
    const result = await Promise.race([
      handle.result,
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);

    expect(result).not.toBeNull();
    if (result) {
      expect(result.sessionId).toBe(sessionId);
      expect(result.response).toBe("ack");
      expect(result.exitCode).toBe(0);
    }

    expect(existsSync(transcriptPath)).toBe(true);
  });
});
