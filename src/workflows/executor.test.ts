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
import { SqliteMemoryStore } from "../memory/sqlite.ts";
import { ProfileStore } from "../memory/profiles/store.ts";
import { HashingEmbeddingProvider } from "../memory/embedding/hashing.ts";
import type { ConsolidationInvoke, ConsolidationOutput } from "../memory/consolidation/types.ts";

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
    const config = testConfig();
    config.repos = [
      {
        name: "widgets-alias",
        path: "/repo/canonical-widgets",
        defaultBase: "main",
        githubRepo: "Acme/Widgets",
      },
      {
        name: "widgets-fork",
        path: "/repo/fork-widgets",
        defaultBase: "main",
        githubRepo: "Other/Widgets",
      },
    ];
    const store = new InMemoryWorkflowStore();
    const executor = new WorkflowExecutor({
      config,
      store,
      slackClient,
      spawn,
      now: () => new Date("2026-05-21T13:30:00.000Z"),
    });

    try {
      const result = await executor.run({
        definition,
        reason: "event",
        triggerContext: {
          source: "github.pr.merged",
          pullRequests: [{
            owner: "acme",
            repo: "widgets",
            branch: "agent/test",
          }],
        },
      });

      expect(result.summary).toContain("Shipped workflow runner");
      expect(captured.session?.cwd).toBe(WORKFLOW_UTILITY_CWD);
      expect(captured.session?.agentType).toBe("default");
      expect(captured.prompt).toContain("Collect my PR and commit activity");
      expect(captured.prompt).toContain("\"path\": \"/repo/canonical-widgets\"");
      expect(captured.prompt).toContain("\"githubRepo\": \"Acme/Widgets\"");
      expect(captured.prompt).not.toContain("/repo/fork-widgets");
      expect(captured.prompt).not.toContain("Other/Widgets");
      expect(captured.prompt).toContain("\"slack.post\"");
      expect(captured.prompt).toContain("\"source\": \"github.pr.merged\"");
      expect(posts).toEqual([
        {
          channel: "C123ABC",
          text: "*Worklog* :white_check_mark:\n- Shipped workflow runner",
        },
      ]);
      expect(readFileSync(result.run.artifactPath, "utf8")).toContain(
        "Shipped workflow runner",
      );
      expect(readFileSync(result.run.artifactPath, "utf8")).toContain(
        'Trigger context: {"source":"github.pr.merged"',
      );
      expect((await store.getRun(result.run.id))?.status).toBe("success");
      expect((await store.getRun(result.run.id))?.providerSessionId).toBe("ses-workflow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the v3 consolidation sweep for memory-consolidation (native-only path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-memory-workflow-test-"));
    const definition = workflowDefinition(dir);
    definition.name = "memory-consolidation";
    definition.nativeHandler = "memory-consolidation";
    definition.triggers = [{ type: "command", command: "memory-consolidation" }];
    definition.outputs = [{ type: "docs", path: join(dir, "memory-consolidation") }];
    definition.permissions.tools = ["docs.write", "memory.read", "memory.write", "memory.evaluate"];
    definition.prompt = "Run memory consolidation.";
    definition.sourcePath = "workflows/memory-consolidation.workflow.md";
    // Remove runner so the v3-sweep-only path is tested (no LLM inspection spawn).
    definition.runner = undefined;
    const store = new InMemoryWorkflowStore();
    const spawn = mock(() => {
      throw new Error("runner should not be spawned without runner config");
    });
    const memoryStore = new SqliteMemoryStore(join(dir, "memory.db"));
    await memoryStore.appendSourceRecord({
      id: "src-wf-1",
      kind: "slack_message",
      threadId: "T-wf",
      actorId: "U_PRANAV",
      actorKind: "human",
      body: "Pranav: always go dev-first, never auto-merge to main",
      createdAt: Date.now(),
    });
    const output: ConsolidationOutput = {
      episodes: [],
      profiles: [],
      claims: [{ kind: "lesson", text: "Go dev-first; never auto-merge straight to main." }],
    };
    const invoke: ConsolidationInvoke = mock(async () => output);
    const executor = new WorkflowExecutor({
      config: testConfig(),
      store,
      spawn: spawn as never,
      memoryStore,
      consolidationDeps: {
        invoke: invoke as ConsolidationInvoke,
        embedder: new HashingEmbeddingProvider(640),
        profileStore: new ProfileStore({ root: join(dir, "profiles") }),
      },
      now: () => new Date("2026-05-24T10:00:00.000Z"),
    });

    try {
      const result = await executor.run({ definition, reason: "manual" });

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(result.summary).toContain("Memory consolidation (v3) complete.");
      expect(result.summary).toContain("1 claims");
      // The claim was actually persisted by the sweep.
      expect(await memoryStore.exportClaimVectors()).toHaveLength(1);
      expect(readFileSync(result.run.artifactPath, "utf8")).toContain("Memory consolidation (v3)");
    } finally {
      memoryStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the dedup sweep natively for memory-dedup-sweep, and never mutates memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-dedup-workflow-test-"));
    const definition = workflowDefinition(dir);
    definition.name = "memory-dedup-sweep";
    definition.nativeHandler = "memory-dedup-sweep";
    definition.triggers = [{ type: "command", command: "memory-dedup-sweep" }];
    definition.outputs = [{ type: "docs", path: join(dir, "memory-dedup-sweep") }];
    definition.permissions.tools = ["docs.write", "memory.read", "memory.evaluate"];
    definition.sourcePath = "workflows/memory-dedup-sweep.workflow.md";
    // No runner: clustering is deterministic, so an agent pass would only
    // paraphrase a report it cannot improve.
    definition.runner = undefined;
    const store = new InMemoryWorkflowStore();
    const spawn = mock(() => {
      throw new Error("runner should not be spawned for the dedup sweep");
    });
    const memoryStore = new SqliteMemoryStore(join(dir, "memory.db"));
    // Two near-identical claims seeded past the guard — the pre-guard corpus state.
    for (const [id, vector] of [
      ["wf-keep", new Float32Array([1, 0, 0, 0])],
      ["wf-dup", new Float32Array([0.95, 0.05, 0, 0])],
    ] as const) {
      await memoryStore.upsertClaim({
        id,
        kind: "lesson",
        text: `claim ${id}`,
        embedding: vector,
        createdAt: Date.now(),
        skipDedup: true,
      });
    }
    const executor = new WorkflowExecutor({
      config: testConfig(),
      store,
      spawn: spawn as never,
      memoryStore,
      now: () => new Date("2026-05-24T10:00:00.000Z"),
    });

    try {
      const result = await executor.run({ definition, reason: "manual" });

      expect(spawn).not.toHaveBeenCalled();
      expect(result.summary).toContain("DRY RUN");
      expect(result.summary).toContain("duplicates found: 1");
      // Scheduled runs REPORT only. Committing a collapse is an explicit
      // operator action, because a merged-away claim is recoverable only from
      // provenance.
      expect(result.summary).toContain("duplicates archived: 0");
      expect(await memoryStore.exportClaimVectors()).toHaveLength(2);
      expect(readFileSync(result.run.artifactPath, "utf8")).toContain("Claim dedup sweep");
    } finally {
      memoryStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs Slack archive maintenance natively without spawning an agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-slack-archive-workflow-test-"));
    const definition = workflowDefinition(dir);
    definition.name = "slack-archive-maintenance";
    definition.nativeHandler = "slack-archive-maintenance";
    definition.runner = undefined;
    definition.outputs = [{ type: "docs", path: join(dir, "slack-archive-maintenance") }];
    definition.permissions.tools = ["slack.read", "archive.write", "docs.write"];
    const config = testConfig();
    config.slackArchive = {
      enabled: true,
      dbPath: join(dir, "archive.db"),
      exportPath: null,
      approvedChannelIds: [],
    };
    const spawn = mock(() => {
      throw new Error("runner should not be spawned for native archive maintenance");
    });
    const executor = new WorkflowExecutor({
      config,
      store: new InMemoryWorkflowStore(),
      slackClient: {} as WebClient,
      spawn: spawn as never,
      slackArchiveMaintenance: async () => ({
        channelsSynced: 12,
        messagesSeen: 34,
        embedded: 7,
        staleSkipped: 0,
        remaining: 0,
        indexed: 770_565,
        indexRebuilt: true,
        dbPath: config.slackArchive!.dbPath,
        indexPath: `${config.slackArchive!.dbPath}.usearch`,
      }),
      now: () => new Date("2026-08-16T03:17:00+05:30"),
    });

    try {
      const result = await executor.run({ definition, reason: "schedule" });
      expect(spawn).not.toHaveBeenCalled();
      expect(result.summary).toContain("channels synced: 12");
      expect(result.summary).toContain("messages embedded: 7");
      expect(result.summary).toContain("ANN index rebuilt: yes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records disabled Slack archive maintenance as skipped instead of failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-slack-archive-disabled-test-"));
    const definition = workflowDefinition(dir);
    definition.name = "slack-archive-maintenance";
    definition.nativeHandler = "slack-archive-maintenance";
    definition.runner = undefined;
    definition.outputs = [{ type: "docs", path: join(dir, "slack-archive-maintenance") }];
    definition.permissions.tools = ["slack.read", "archive.write", "docs.write"];
    const store = new InMemoryWorkflowStore();
    const executor = new WorkflowExecutor({
      config: testConfig(),
      store,
      slackClient: {} as WebClient,
      now: () => new Date("2026-08-16T03:17:00+05:30"),
    });

    try {
      const result = await executor.run({ definition, reason: "schedule" });
      expect(result.run.status).toBe("skipped");
      expect(result.summary).toContain("Slack archive is not enabled");
      expect((await store.getRun(result.run.id))?.status).toBe("skipped");
      expect(readFileSync(result.run.artifactPath, "utf8")).toContain("Status: skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not spawn a second inspection runner for memory-consolidation (sweep-only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-memory-sweeponly-test-"));
    const definition = workflowDefinition(dir);
    definition.name = "memory-consolidation";
    definition.nativeHandler = "memory-consolidation";
    definition.triggers = [{ type: "command", command: "memory-consolidation" }];
    definition.outputs = [{ type: "docs", path: join(dir, "memory-consolidation") }];
    definition.permissions.tools = ["docs.write", "memory.read", "memory.write", "memory.evaluate"];
    definition.sourcePath = "workflows/memory-consolidation.workflow.md";
    // Runner config is PRESENT but must be ignored: the v3 sweep is the only
    // LLM pass; no second inspection-agent spawn.
    const store = new InMemoryWorkflowStore();
    const memoryStore = new SqliteMemoryStore(join(dir, "memory.db"));
    await memoryStore.appendSourceRecord({
      id: "src-wf-sweeponly",
      kind: "slack_message",
      threadId: "T-wf-sweeponly",
      actorId: "U_PRANAV",
      actorKind: "human",
      body: "Pranav: never squash-merge; always 3-way",
      createdAt: Date.now(),
    });
    const invoke: ConsolidationInvoke = mock(async () => ({
      episodes: [],
      profiles: [],
      claims: [{ kind: "lesson", text: "Never squash-merge; always use a 3-way merge." }],
    }) as ConsolidationOutput);
    let spawnCalls = 0;
    const spawn: SpawnRunnerFn = (_session, _prompt): SpawnHandle => {
      spawnCalls += 1;
      return {
        provider: "opencode",
        result: Promise.resolve({
          provider: "opencode",
          sessionId: "ses-llm",
          response: "should not be called",
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
      memoryStore,
      consolidationDeps: {
        invoke: invoke as ConsolidationInvoke,
        embedder: new HashingEmbeddingProvider(640),
        profileStore: new ProfileStore({ root: join(dir, "profiles") }),
      },
      now: () => new Date("2026-05-24T10:00:00.000Z"),
    });

    try {
      const result = await executor.run({ definition, reason: "schedule" });

      // The sweep's injected LLM ran once; the inspection runner did NOT spawn.
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(spawnCalls).toBe(0);
      expect(result.summary).toContain("Memory consolidation (v3) complete.");
      expect(result.summary).not.toContain("## LLM Analysis");
    } finally {
      memoryStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interrupts and resumes an idle workflow runner with the provider session id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-workflow-idle-test-"));
    const definition = workflowDefinition(dir);
    definition.runner = {
      provider: "default",
      agentName: "default",
      timeoutMs: 1000,
      idleTimeoutMs: 10,
      maxIdleInterrupts: 1,
    };
    const store = new InMemoryWorkflowStore();
    const killSignals: Array<string | undefined> = [];
    const seenSessionIds: Array<string | null | undefined> = [];
    let callCount = 0;
    const spawn: SpawnRunnerFn = (session, _prompt): SpawnHandle => {
      callCount += 1;
      seenSessionIds.push(session.sessionId);
      if (callCount === 1) {
        let resolve!: (result: Awaited<SpawnHandle["result"]>) => void;
        const result = new Promise<Awaited<SpawnHandle["result"]>>((next) => {
          resolve = next;
        });
        return {
          provider: "opencode",
          result,
          onEvent: (cb) => setTimeout(() => cb({
            type: "init",
            provider: "opencode",
            sessionId: "ses-idle",
          }), 0),
          kill: (signal) => {
            killSignals.push(signal);
            resolve({
              provider: "opencode",
              sessionId: "ses-idle",
              response: "",
              events: [],
              exitCode: 130,
              error: "interrupted",
            });
          },
          pid: null,
        };
      }

      return {
        provider: "opencode",
        result: Promise.resolve({
          provider: "opencode",
          sessionId: "ses-idle",
          response: "Resumed and completed.",
          events: [],
          exitCode: 0,
          error: null,
        }),
        onEvent: (cb) => cb({
          type: "init",
          provider: "opencode",
          sessionId: "ses-idle",
        }),
        kill: () => undefined,
        pid: null,
      };
    };
    const config = testConfig();
    config.opencode.continuityEnabled = true;
    const executor = new WorkflowExecutor({
      config,
      store,
      spawn,
      now: () => new Date("2026-05-24T11:00:00.000Z"),
    });

    try {
      const result = await executor.run({ definition, reason: "manual" });

      expect(result.summary).toBe("Resumed and completed.");
      expect(callCount).toBe(2);
      expect(killSignals).toContain("SIGINT");
      expect(seenSessionIds).toEqual([null, "ses-idle"]);
      expect((await store.getRun(result.run.id))?.providerSessionId).toBe("ses-idle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not idle-interrupt workflow runners for server-attached providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-workflow-server-provider-test-"));
    const definition = workflowDefinition(dir);
    definition.runner = {
      provider: "default",
      agentName: "default",
      timeoutMs: 1000,
      idleTimeoutMs: 10,
      maxIdleInterrupts: 1,
    };
    const store = new InMemoryWorkflowStore();
    const killSignals: Array<string | undefined> = [];
    const spawn: SpawnRunnerFn = (): SpawnHandle => {
      return {
        provider: "codex-app-server",
        result: new Promise((resolve) => {
          setTimeout(() => resolve({
            provider: "codex-app-server",
            sessionId: null,
            response: "Completed after quiet server-attached work.",
            events: [],
            exitCode: 0,
            error: null,
          }), 30);
        }),
        onEvent: () => {},
        kill: (signal) => {
          killSignals.push(signal);
        },
        pid: null,
      };
    };
    const config = testConfig();
    config.runner.provider = "codex-app-server";
    const executor = new WorkflowExecutor({
      config,
      store,
      spawn,
      now: () => new Date("2026-05-24T11:30:00.000Z"),
    });

    try {
      const result = await executor.run({ definition, reason: "manual" });

      expect(result.summary).toBe("Completed after quiet server-attached work.");
      expect(killSignals).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not idle-interrupt opencode workflow runners when continuity is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-workflow-opencode-no-continuity-test-"));
    const definition = workflowDefinition(dir);
    definition.runner = {
      provider: "default",
      agentName: "default",
      timeoutMs: 1000,
      idleTimeoutMs: 10,
      maxIdleInterrupts: 1,
    };
    const store = new InMemoryWorkflowStore();
    const killSignals: Array<string | undefined> = [];
    const spawn: SpawnRunnerFn = (): SpawnHandle => {
      return {
        provider: "opencode",
        result: new Promise((resolve) => {
          setTimeout(() => resolve({
            provider: "opencode",
            sessionId: null,
            response: "Completed without continuity.",
            events: [],
            exitCode: 0,
            error: null,
          }), 30);
        }),
        onEvent: () => {},
        kill: (signal) => {
          killSignals.push(signal);
        },
        pid: null,
      };
    };
    const config = testConfig();
    config.opencode.continuityEnabled = false;
    const executor = new WorkflowExecutor({
      config,
      store,
      spawn,
      now: () => new Date("2026-05-24T12:00:00.000Z"),
    });

    try {
      const result = await executor.run({ definition, reason: "manual" });

      expect(result.summary).toBe("Completed without continuity.");
      expect(killSignals).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminates active workflow runner handles on shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-workflow-shutdown-test-"));
    const definition = workflowDefinition(dir);
    const store = new InMemoryWorkflowStore();
    const killSignals: Array<string | undefined> = [];
    let resolveResult!: (result: Awaited<SpawnHandle["result"]>) => void;
    const spawn: SpawnRunnerFn = (): SpawnHandle => ({
      provider: "opencode",
      result: new Promise((resolve) => {
        resolveResult = resolve;
      }),
      onEvent: (cb) => setTimeout(() => cb({
        type: "init",
        provider: "opencode",
        sessionId: "ses-shutdown",
      }), 0),
      kill: (signal) => {
        killSignals.push(signal);
        resolveResult({
          provider: "opencode",
          sessionId: "ses-shutdown",
          response: "",
          events: [],
          exitCode: 130,
          error: "shutdown",
        });
      },
      pid: 98765,
    });
    const executor = new WorkflowExecutor({
      config: testConfig(),
      store,
      spawn,
      now: () => new Date("2026-05-24T12:00:00.000Z"),
    });

    try {
      const runPromise = executor.run({ definition, reason: "manual" }).catch((err) => err);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await executor.terminateActiveRuns();
      const outcome = await runPromise;

      expect(killSignals).toContain("SIGINT");
      expect(outcome).toBeInstanceOf(Error);
      const runs = await store.listRuns(definition.name, 1);
      expect(runs[0]?.providerSessionId).toBe("ses-shutdown");
      expect(runs[0]?.status).toBe("failed");
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
      continuityEnabled: false,
      permission: "allow",
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
    },
    codex: {
      mode: "app-server",
      model: null,
      timeoutMs: 300000,
      sandbox: "workspace-write",
      askForApproval: "never",
      searchEnabled: false,
      appServerContinuityEnabled: false,
      mcpEnabled: true,
      slackMcpEnabled: true,
      playwrightMcpEnabled: true,
      mixpanelMcpEnabled: true,
      mongodbMcpEnabled: true,
      memoryMcpEnabled: true,
      isolatedHomePath: "data/codex-home",
    },
    repos: [{ name: "junior", path: "/repo/junior", defaultBase: "main" }],
    session: {
      staleTimeoutMs: 86400000,
      cleanupIntervalMs: 900000,
      store: "memory",
      sqlitePath: "data/sessions.db",
      homeWindowMs: 172800000,
      defaultVerbosity: "normal",
      idleTimeoutMs: 300000,
      maxIdleInterrupts: 3,
      shortFollowupInterruptEnabled: false,
      shortFollowupMaxLength: 280,
    },
    memory: { sqlitePath: "data/memory.db" },
    threadArchives: { dir: "data/thread-archives" },
    channelDefaults: {},
    adminSlackUserId: null,
    http: { enabled: false, port: 0 },
  };
}
