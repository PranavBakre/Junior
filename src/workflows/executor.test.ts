import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import type { Config } from "../config.ts";
import type { SpawnHandle, SpawnRunnerFn } from "../runners/types.ts";
import type { ThreadSession } from "../session/types.ts";
import { WorkflowExecutor, WORKFLOW_UTILITY_CWD } from "./executor.ts";
import { InMemoryWorkflowStore } from "./store.ts";
import type { WorkflowDefinition } from "./types.ts";

describe("WorkflowExecutor", () => {
  it("runs workflow definitions through the configured runner from utility cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-workflow-test-"));
    const posts: Array<Record<string, unknown>> = [];
    const captured: { session?: ThreadSession; prompt?: string } = {};
    const spawn: SpawnRunnerFn = (session, prompt): SpawnHandle => {
      captured.session = session;
      captured.prompt = prompt;
      return {
        provider: "opencode",
        result: Promise.resolve({
          provider: "opencode",
          sessionId: "ses-workflow",
          response: "*Worklog* :white_check_mark:\n- Shipped workflow runner",
          events: [],
          exitCode: 0,
          error: null,
        }),
        onEvent: (cb) => cb({
          type: "init",
          provider: "opencode",
          sessionId: "ses-workflow",
        }),
        kill: () => undefined,
        pid: null,
      };
    };
    const slackClient = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          posts.push(args);
          return { ok: true, ts: "123.456" };
        },
      },
    } as unknown as WebClient;
    const definition = workflowDefinition(dir);
    const store = new InMemoryWorkflowStore();
    const executor = new WorkflowExecutor({
      config: testConfig(),
      store,
      slackClient,
      spawn,
      now: () => new Date("2026-05-21T13:30:00.000Z"),
    });

    try {
      const result = await executor.run({
        definition,
        reason: "manual",
        actorSlackUserId: "U123ABC",
      });

      expect(result.summary).toContain("Shipped workflow runner");
      expect(captured.session?.cwd).toBe(WORKFLOW_UTILITY_CWD);
      expect(captured.session?.agentType).toBe("default");
      expect(captured.prompt).toContain("Collect my PR and commit activity");
      expect(captured.prompt).toContain("\"path\": \"/repo/junior\"");
      expect(captured.prompt).toContain("\"slack.post\"");
      expect(posts).toEqual([
        {
          channel: "C123ABC",
          text: "*Worklog* :white_check_mark:\n- Shipped workflow runner",
        },
      ]);
      expect(readFileSync(result.run.artifactPath, "utf8")).toContain(
        "Shipped workflow runner",
      );
      expect((await store.getRun(result.run.id))?.status).toBe("success");
      expect((await store.getRun(result.run.id))?.providerSessionId).toBe("ses-workflow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs memory consolidation workflows through the memory store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-memory-workflow-test-"));
    const definition = workflowDefinition(dir);
    definition.name = "memory-consolidation";
    definition.triggers = [{ type: "command", command: "memory-consolidation" }];
    definition.outputs = [{ type: "docs", path: join(dir, "memory-consolidation") }];
    definition.permissions.tools = ["docs.write", "memory.read", "memory.write", "memory.evaluate"];
    definition.prompt = "Run memory consolidation.";
    definition.sourcePath = "workflows/memory-consolidation.workflow.md";
    // Remove runner so native-only path is tested (no LLM spawn).
    definition.runner = undefined;
    const store = new InMemoryWorkflowStore();
    const spawn = mock(() => {
      throw new Error("runner should not be spawned without runner config");
    });
    const memoryStore = {
      consolidate: mock(async () => ({
        promotedMemoryIds: ["mem-1"],
        archivedEventIds: ["event-1"],
        proposedRuleIds: ["rule-1"],
        decisions: [{ id: "decision-1" }],
      })),
    };
    const executor = new WorkflowExecutor({
      config: testConfig(),
      store,
      spawn: spawn as never,
      memoryStore: memoryStore as never,
      now: () => new Date("2026-05-24T10:00:00.000Z"),
    });

    try {
      const result = await executor.run({ definition, reason: "manual" });

      expect(memoryStore.consolidate).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(result.summary).toContain("Memory consolidation complete.");
      expect(result.summary).toContain("Promoted memories: mem-1");
      expect(readFileSync(result.run.artifactPath, "utf8")).toContain("Archived events: event-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs native consolidation then LLM analysis for memory-consolidation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-memory-llm-workflow-test-"));
    const definition = workflowDefinition(dir);
    definition.name = "memory-consolidation";
    definition.triggers = [{ type: "command", command: "memory-consolidation" }];
    definition.outputs = [{ type: "docs", path: join(dir, "memory-consolidation") }];
    definition.permissions.tools = ["docs.write", "memory.read", "memory.write", "memory.evaluate"];
    definition.prompt = "Inspect and validate consolidation results.";
    definition.sourcePath = "workflows/memory-consolidation.workflow.md";
    // Keep runner config so LLM pass runs after native.
    const store = new InMemoryWorkflowStore();
    const memoryStore = {
      consolidate: mock(async () => ({
        promotedMemoryIds: ["mem-1"],
        archivedEventIds: ["event-1"],
        proposedRuleIds: ["rule-1"],
        decisions: [{ id: "decision-1" }],
      })),
    };
    const spawn: SpawnRunnerFn = (_session, _prompt): SpawnHandle => {
      return {
        provider: "opencode",
        result: Promise.resolve({
          provider: "opencode",
          sessionId: "ses-llm",
          response: "LLM analysis: confirmed 1 promotion, 1 archive, 1 draft rule.",
          events: [],
          exitCode: 0,
          error: null,
        }),
        onEvent: () => {},
        kill: () => undefined,
        pid: null,
      };
    };
    const executor = new WorkflowExecutor({
      config: testConfig(),
      store,
      spawn,
      memoryStore: memoryStore as never,
      now: () => new Date("2026-05-24T10:00:00.000Z"),
    });

    try {
      const result = await executor.run({ definition, reason: "schedule" });

      expect(memoryStore.consolidate).toHaveBeenCalledTimes(1);
      expect(result.summary).toContain("Memory consolidation complete.");
      expect(result.summary).toContain("## LLM Analysis");
      expect(result.summary).toContain("LLM analysis: confirmed 1 promotion");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function workflowDefinition(root: string): WorkflowDefinition {
  return {
    name: "worklog",
    enabled: true,
    description: "Daily worklog",
    ownerSlackUserIds: [],
    triggers: [{ type: "command", command: "worklog" }],
    outputs: [
      { type: "docs", path: join(root, "worklog") },
      { type: "slack", channel: "C123ABC" },
    ],
    permissions: {
      tools: ["git", "gh", "docs.write", "slack.post"],
    },
    runner: {
      provider: "default",
      agentName: "default",
      timeoutMs: 1000,
    },
    concurrency: "skip",
    prompt: "Collect my PR and commit activity from the last 24 hours.",
    versionHash: "1234567890abcdef",
    sourcePath: "workflows/worklog.workflow.md",
    sourceRoot: "public",
  };
}

function testConfig(): Config {
  return {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "",
    },
    claude: {
      maxTurns: 25,
      timeoutMs: 300000,
      permissionMode: "bypassPermissions",
      defaultModel: null,
      defaultDriver: "headless",
      tmuxIdleTtlMs: 14400000,
      tmuxSweepIntervalMs: 900000,
    },
    runner: { provider: "opencode" },
    opencode: {
      model: null,
      timeoutMs: 300000,
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
    },
    repos: [{ name: "junior", path: "/repo/junior", defaultBase: "main" }],
    session: {
      staleTimeoutMs: 86400000,
      cleanupIntervalMs: 900000,
      store: "memory",
      sqlitePath: "data/sessions.db",
      homeWindowMs: 172800000,
      defaultVerbosity: "normal",
    },
    memory: { sqlitePath: "data/memory.db" },
    channelDefaults: {},
    adminSlackUserId: null,
    http: { enabled: false, port: 0 },
  };
}
