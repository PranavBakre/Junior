import { describe, it, expect } from "bun:test";
import { createSession, normalizeRunnerProvider } from "./types.ts";

describe("createSession", () => {
  it("returns correct shape with threadId and channel", () => {
    const session = createSession("thread-1", "C01ABC");
    expect(session.threadId).toBe("thread-1");
    expect(session.channel).toBe("C01ABC");
  });

  it("has status set to idle", () => {
    const session = createSession("t1", "C01");
    expect(session.status).toBe("idle");
  });

  it("has sessionId as null", () => {
    const session = createSession("t1", "C01");
    expect(session.sessionId).toBeNull();
  });

  it("has provider set to claude by default", () => {
    const session = createSession("t1", "C01");
    expect(session.provider).toBe("claude");
  });

  it("has leadSessionId as null", () => {
    const session = createSession("t1", "C01");
    expect(session.leadSessionId).toBeNull();
  });

  it("has agentSessions as an empty object", () => {
    const session = createSession("t1", "C01");
    expect(session.agentSessions).toEqual({});
  });

  it("has worktreePath as null", () => {
    const session = createSession("t1", "C01");
    expect(session.worktreePath).toBeNull();
  });

  it("has agentType as null", () => {
    const session = createSession("t1", "C01");
    expect(session.agentType).toBeNull();
  });

  it("has targetRepo as null", () => {
    const session = createSession("t1", "C01");
    expect(session.targetRepo).toBeNull();
  });

  it("has baseRef as null", () => {
    const session = createSession("t1", "C01");
    expect(session.baseRef).toBeNull();
  });

  it("has systemPrompt as null", () => {
    const session = createSession("t1", "C01");
    expect(session.systemPrompt).toBeNull();
  });

  it("has pid as null", () => {
    const session = createSession("t1", "C01");
    expect(session.pid).toBeNull();
  });

  it("has lastError as null", () => {
    const session = createSession("t1", "C01");
    expect(session.lastError).toBeNull();
  });

  it("has pendingMessages as empty array", () => {
    const session = createSession("t1", "C01");
    expect(session.pendingMessages).toEqual([]);
  });

  it("has verbosity set to normal by default", () => {
    const session = createSession("t1", "C01");
    expect(session.verbosity).toBe("normal");
  });

  it("uses provided default verbosity", () => {
    const session = createSession("t1", "C01", "verbose");
    expect(session.verbosity).toBe("verbose");
  });

  it("has muted set to false by default", () => {
    const session = createSession("t1", "C01");
    expect(session.muted).toBe(false);
  });

  it("has lastActivity as a recent timestamp", () => {
    const before = Date.now();
    const session = createSession("t1", "C01");
    const after = Date.now();
    expect(session.lastActivity).toBeGreaterThanOrEqual(before);
    expect(session.lastActivity).toBeLessThanOrEqual(after);
  });

  it("has createdAt as a recent timestamp", () => {
    const before = Date.now();
    const session = createSession("t1", "C01");
    const after = Date.now();
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
  });

  it("returns all expected keys", () => {
    const session = createSession("t1", "C01");
    const keys = Object.keys(session).sort();
    expect(keys).toEqual([
      "activePipelineKind",
      "activePipelineRunId",
      "agentSessions",
      "agentType",
      "baseRef",
      "channel",
      "createdAt",
      "cwd",
      "dormant",
      "dormantAnnounced",
      "driverMode",
      "engagedHumans",
      "humanParticipants",
      "idleInterruptCount",
      "lastActivity",
      "lastError",
      "leadSessionId",
      "model",
      "muted",
      "needsThreadCatchup",
      "pendingMessages",
      "pid",
      "pipelineGuardRetryCount",
      "provider",
      "sessionId",
      "stateVersion",
      "status",
      "systemPrompt",
      "targetRepo",
      "threadId",
      "tmuxSessionName",
      "topLevelTmuxAgent",
      "verbosity",
      "worktreePath",
      "worktreePaths",
    ]);
  });

  it("has stateVersion set to 0 by default", () => {
    const session = createSession("t1", "C01");
    expect(session.stateVersion).toBe(0);
  });

  it("has dormant set to false by default", () => {
    const session = createSession("t1", "C01");
    expect(session.dormant).toBe(false);
  });

  it("has needsThreadCatchup set to false by default", () => {
    const session = createSession("t1", "C01");
    expect(session.needsThreadCatchup).toBe(false);
  });

  it("has dormantAnnounced set to false by default", () => {
    const session = createSession("t1", "C01");
    expect(session.dormantAnnounced).toBe(false);
  });

  it("has humanParticipants as empty array by default", () => {
    const session = createSession("t1", "C01");
    expect(session.humanParticipants).toEqual([]);
  });

  it("has engagedHumans as empty array by default", () => {
    const session = createSession("t1", "C01");
    expect(session.engagedHumans).toEqual([]);
  });
});

describe("normalizeRunnerProvider", () => {
  it("keeps supported providers", () => {
    expect(normalizeRunnerProvider("claude")).toBe("claude");
    expect(normalizeRunnerProvider("opencode")).toBe("opencode");
    expect(normalizeRunnerProvider("codex")).toBe("codex");
  });

  it("defaults missing or invalid values to claude", () => {
    expect(normalizeRunnerProvider(undefined)).toBe("claude");
    expect(normalizeRunnerProvider(null)).toBe("claude");
    expect(normalizeRunnerProvider("unknown")).toBe("claude");
  });
});
