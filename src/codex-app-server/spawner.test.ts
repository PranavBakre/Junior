import { afterEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { WORKFLOW_UTILITY_CWD } from "../runners/runtime.ts";
import { createSession } from "../session/types.ts";
import { resolveCodexModel, spawnCodexAppServer } from "./spawner.ts";
import { resolveTrustedSkill } from "../skills/registry.ts";
import { configureSlackApprovalBridge } from "../mcp/slack-approval-bridge.ts";
import { resolvePendingApproval } from "../mcp/approval.ts";
import type { CreateSlackActionRecord, SlackActionStore } from "../slack/action-store.ts";
import { resolveDispatchAgent } from "../slack/action-buttons.ts";
import type { WebClient } from "@slack/web-api";

const originalCodexBin = process.env.CODEX_BIN;

afterEach(() => {
  configureSlackApprovalBridge(undefined, undefined);
  if (originalCodexBin == null) {
    delete process.env.CODEX_BIN;
  } else {
    process.env.CODEX_BIN = originalCodexBin;
  }
});

describe("spawnCodexAppServer", () => {
  const approvalCases = [
    {
      method: "item/commandExecution/requestApproval",
      params: { command: "git fetch" },
      expected: { decision: "accept" },
    },
    {
      method: "item/fileChange/requestApproval",
      params: { reason: "edit source" },
      expected: { decision: "accept" },
    },
    {
      method: "item/permissions/requestApproval",
      params: { permissions: { network: { enabled: true } } },
      expected: {
        permissions: { network: { enabled: true } },
        scope: "turn",
      },
    },
  ] as const;

  for (const approvalCase of approvalCases) {
    it(`returns the protocol response for ${approvalCase.method}`, async () => {
      const fakeCodex = installFakeCodex(approvalFakeCodexScript(
        approvalCase.method,
        approvalCase.params,
      ));
      process.env.CODEX_BIN = fakeCodex.command;
      const store = {
        createMany: mock(async (records: CreateSlackActionRecord[]) => {
          const allow = records.find((row) =>
            row.action.type === "request_permission" && row.action.decision === "allow"
          );
          if (allow?.action.type !== "request_permission") {
            throw new Error("missing allow action");
          }
          resolvePendingApproval(allow.action.approvalToken, "allow");
        }),
      } as unknown as SlackActionStore;
      const client = {
        chat: { postMessage: mock(async () => ({ ok: true, ts: "10.20" })) },
      } as unknown as WebClient;
      configureSlackApprovalBridge(client, store);

      try {
        const session = createSession("thread-approval", "C01");
        session.provider = "codex-app-server";
        const config = {
          ...testConfig,
          codex: {
            ...testConfig.codex,
            isolatedHomePath: join(fakeCodex.root, "codex-home"),
          },
        };
        const result = await spawnCodexAppServer(session, "needs approval", config).result;
        expect(result.error).toBeNull();
        expect(result.completion).toEqual({
          status: "success",
          reason: "completed",
          retryable: false,
        });

        const messages = readFileSync(join(fakeCodex.root, "requests.jsonl"), "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        const response = messages.find((message) => message.id === 900 && !message.method);
        expect(response).toEqual({ jsonrpc: "2.0", id: 900, result: approvalCase.expected });
      } finally {
        fakeCodex.cleanup();
      }
    });
  }

  it("cancels an outstanding approval when app-server exits", async () => {
    const fakeCodex = installFakeCodex(exitingApprovalFakeCodexScript());
    process.env.CODEX_BIN = fakeCodex.command;
    const rows: CreateSlackActionRecord[] = [];
    const disabled: Array<[string, string]> = [];
    const store = {
      createMany: mock(async (records: CreateSlackActionRecord[]) => {
        rows.push(...records);
      }),
      disableMessageActions: mock(async (channel: string, messageTs: string) => {
        disabled.push([channel, messageTs]);
      }),
    } as unknown as SlackActionStore;
    const update = mock(async () => ({ ok: true }));
    const client = {
      chat: {
        postMessage: mock(async () => ({ ok: true, ts: "10.20" })),
        update,
      },
    } as unknown as WebClient;
    configureSlackApprovalBridge(client, store);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const session = createSession("thread-approval-exit", "C01");
      session.provider = "codex-app-server";
      const config = {
        ...testConfig,
        codex: {
          ...testConfig.codex,
          isolatedHomePath: join(fakeCodex.root, "codex-home"),
        },
      };
      await spawnCodexAppServer(session, "needs approval", config).result;
      await Bun.sleep(25);

      expect(rows).toHaveLength(2);
      const allow = rows.find((row) =>
        row.action.type === "request_permission" && row.action.decision === "allow"
      );
      if (allow?.action.type !== "request_permission") {
        throw new Error("missing allow action");
      }
      expect(resolvePendingApproval(allow.action.approvalToken, "allow")).toBe(false);
      expect(disabled).toEqual([["C01", "10.20"]]);
      expect(update).toHaveBeenCalledWith({
        channel: "C01",
        ts: "10.20",
        text: expect.any(String),
        blocks: [],
      });
      const messages = readFileSync(join(fakeCodex.root, "requests.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(messages.some((message) => message.id === 900 && !message.method)).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      fakeCodex.cleanup();
    }
  });

  it("fails pending JSON-RPC requests when the process exits before responding", async () => {
    const fakeCodex = installFakeCodex();
    process.env.CODEX_BIN = fakeCodex.command;

    try {
      const session = createSession("thread-1", "C01");
      session.provider = "codex-app-server";
      const config = {
        ...testConfig,
        codex: {
          ...testConfig.codex,
          isolatedHomePath: join(fakeCodex.root, "codex-home"),
        },
      };

      const handle = spawnCodexAppServer(session, "hello", config);
      const result = await Promise.race([
        handle.result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 1000)),
      ]);

      expect(result.exitCode).toBe(42);
      expect(result.error).toContain("Codex app-server exited before replying to pending requests");
      expect(result.completion).toEqual({
        status: "failure",
        reason: "process_error",
        retryable: false,
        providerSubtype: "app-server-process",
      });
    } finally {
      fakeCodex.cleanup();
    }
  });

  it("sends explicit danger-full-access sandbox params for app-server runs", async () => {
    const fakeCodex = installFakeCodex(recordingFakeCodexScript());
    process.env.CODEX_BIN = fakeCodex.command;

    try {
      const session = createSession("thread-1", "C01");
      session.provider = "codex-app-server";
      const config = {
        ...testConfig,
        codex: {
          ...testConfig.codex,
          sandbox: "danger-full-access" as const,
          isolatedHomePath: join(fakeCodex.root, "codex-home"),
        },
      };

      const handle = spawnCodexAppServer(session, "hello", config);
      const result = await Promise.race([
        handle.result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 1000)),
      ]);

      expect(result.exitCode).toBe(0);
      const requests = readFileSync(join(fakeCodex.root, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const threadStart = requests.find((request) => request.method === "thread/start");
      const turnStart = requests.find((request) => request.method === "turn/start");
      expect(threadStart.params).not.toHaveProperty("baseInstructions");
      expect(threadStart.params.developerInstructions).toContain(
        "You are Junior running inside Codex",
      );
      expect(threadStart.params.sandbox).toBe("danger-full-access");
      expect(threadStart.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
      expect(threadStart.params.environments).toEqual([]);
      expect(turnStart.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    } finally {
      fakeCodex.cleanup();
    }
  });

  it("enables the local Codex environment for a registered review worktree", async () => {
    const fakeCodex = installFakeCodex(recordingFakeCodexScript());
    process.env.CODEX_BIN = fakeCodex.command;

    try {
      const session = createSession("review-thread", "C01");
      session.provider = "codex-app-server";
      session.activeAgentName = "review";
      session.worktreePath = join(fakeCodex.root, "repo.junior-worktrees", "slack-review-thread");
      mkdirSync(session.worktreePath, { recursive: true });
      session.worktreePaths = { repo: session.worktreePath };
      session.agentPermissions = { intent: "read-only", mcp: [], tools: [] };
      const config = {
        ...testConfig,
        codex: {
          ...testConfig.codex,
          isolatedHomePath: join(fakeCodex.root, "codex-home"),
        },
      };

      await spawnCodexAppServer(
        session,
        "review",
        config,
        session.worktreePath,
      ).result;
      const requests = readFileSync(join(fakeCodex.root, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const threadStart = requests.find((request) => request.method === "thread/start");
      expect(threadStart.params).not.toHaveProperty("environments");
    } finally {
      fakeCodex.cleanup();
    }
  });

  it("enables the local Codex environment for trusted utility workflows", async () => {
    const fakeCodex = installFakeCodex(recordingFakeCodexScript());
    process.env.CODEX_BIN = fakeCodex.command;

    try {
      const session = createSession("workflow-worktree-prune", "workflow");
      session.provider = "codex-app-server";
      session.activeAgentName = "default";
      session.agentType = "default";
      session.cwd = WORKFLOW_UTILITY_CWD;
      const config = {
        ...testConfig,
        codex: {
          ...testConfig.codex,
          isolatedHomePath: join(fakeCodex.root, "codex-home"),
        },
      };

      await spawnCodexAppServer(session, "run workflow", config).result;
      const requests = readFileSync(join(fakeCodex.root, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const threadStart = requests.find((request) => request.method === "thread/start");
      expect(threadStart.params).not.toHaveProperty("environments");
    } finally {
      fakeCodex.cleanup();
    }
  });

  it("preserves the execution surface for every Slack capability regression without a model", async () => {
    const mergeAgent = resolveDispatchAgent(
      {
        channelId: "C0AKQ2BFN9F",
        action: {
          id: "review:merge-gxt-admin",
          label: "Merge via gxt-admin",
          type: "dispatch_agent",
          agent: "lead",
          prompt: "merge the review-approved PR",
        },
      },
      new Set(),
    );
    const cases = [
      {
        name: "merge-gxt-admin default run 1787592295.000879",
        agent: mergeAgent,
        cwdKind: "worktree",
        expectsLocalEnvironment: true,
      },
      {
        name: "private PR review managed checkout",
        agent: "review",
        cwdKind: "worktree",
        expectsLocalEnvironment: true,
      },
      {
        name: "DB migration artifact managed checkout",
        agent: "db-executioner",
        cwdKind: "worktree",
        expectsLocalEnvironment: true,
      },
      {
        name: "managed worktree cleanup",
        agent: "default",
        cwdKind: "worktree",
        expectsLocalEnvironment: true,
      },
      {
        name: "scheduled worktree-prune workflow 1787621417.595599",
        agent: "default",
        cwdKind: "utility",
        expectsLocalEnvironment: true,
      },
      {
        name: "scheduled worklog workflow",
        agent: "default",
        cwdKind: "utility",
        expectsLocalEnvironment: true,
      },
      {
        name: "repo-less MCP-only member lookup",
        agent: "onboard-member",
        cwdKind: "repo-less",
        expectsLocalEnvironment: false,
      },
    ] as const;

    for (const regression of cases) {
      const fakeCodex = installFakeCodex(recordingFakeCodexScript());
      process.env.CODEX_BIN = fakeCodex.command;
      try {
        const session = createSession(`regression-${regression.agent}`, "C-SLACK");
        session.provider = "codex-app-server";
        session.activeAgentName = regression.agent;
        session.agentType = regression.agent;
        if (regression.cwdKind === "worktree") {
          session.worktreePath = join(
            fakeCodex.root,
            "repo.junior-worktrees",
            `slack-${regression.agent}`,
          );
          mkdirSync(session.worktreePath, { recursive: true });
          session.worktreePaths = { repo: session.worktreePath };
        } else if (regression.cwdKind === "utility") {
          session.cwd = WORKFLOW_UTILITY_CWD;
        }
        const config = {
          ...testConfig,
          codex: {
            ...testConfig.codex,
            isolatedHomePath: join(fakeCodex.root, "codex-home"),
          },
        };

        await spawnCodexAppServer(
          session,
          regression.name,
          config,
          session.worktreePath ?? undefined,
        ).result;
        const requests = readFileSync(join(fakeCodex.root, "requests.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const threadStart = requests.find((request) => request.method === "thread/start");
        if (regression.expectsLocalEnvironment) {
          expect(threadStart.params).not.toHaveProperty("environments");
        } else {
          expect(threadStart.params.environments).toEqual([]);
        }
      } finally {
        fakeCodex.cleanup();
      }
    }
  }, 20_000);

  it("invokes an assignment skill as a structured turn item without changing developer instructions", async () => {
    const fakeCodex = installFakeCodex(recordingFakeCodexScript());
    process.env.CODEX_BIN = fakeCodex.command;

    try {
      const session = createSession("thread-skill", "C01");
      session.provider = "codex-app-server";
      const skill = resolveTrustedSkill("sentry-fetch")!;
      session.activeSkill = {
        name: skill.name,
        path: skill.path,
        execution: "stateless",
      };
      const config = {
        ...testConfig,
        codex: {
          ...testConfig.codex,
          isolatedHomePath: join(fakeCodex.root, "codex-home"),
        },
      };

      await spawnCodexAppServer(session, "inspect the last hour", config).result;
      const requests = readFileSync(join(fakeCodex.root, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const threadStart = requests.find((request) => request.method === "thread/start");
      const turnStart = requests.find((request) => request.method === "turn/start");
      expect(threadStart.params.developerInstructions).not.toContain("# Sentry evidence");
      expect(turnStart.params.input).toContainEqual({
        type: "skill",
        name: "sentry-fetch",
        path: skill.path,
      });
      expect(turnStart.params.input[0].text).toContain("$sentry-fetch");
    } finally {
      fakeCodex.cleanup();
    }
  });

  it("starts a fresh app-server thread when persisted resume rollout is missing", async () => {
    const fakeCodex = installFakeCodex(missingRolloutThenStartFakeCodexScript());
    process.env.CODEX_BIN = fakeCodex.command;

    try {
      const session = createSession("thread-1", "C01");
      session.provider = "codex-app-server";
      session.sessionId = "missing-thread";
      const config = {
        ...testConfig,
        codex: {
          ...testConfig.codex,
          isolatedHomePath: join(fakeCodex.root, "codex-home"),
        },
      };

      const handle = spawnCodexAppServer(session, "hello after restart", config);
      const result = await Promise.race([
        handle.result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 3000)),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.error).toBeNull();
      expect(result.sessionId).toBe("thread-created");

      const requests = readFileSync(join(fakeCodex.root, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "thread/resume",
        "thread/start",
        "turn/start",
      ]);
      expect(requests.find((request) => request.method === "thread/resume").params.environments)
        .toEqual([]);
      expect(requests.find((request) => request.method === "thread/start").params.environments)
        .toEqual([]);
      expect(requests.find((request) => request.method === "turn/start").params.threadId)
        .toBe("thread-created");
    } finally {
      fakeCodex.cleanup();
    }
  });
});

describe("resolveCodexModel", () => {
  it("ignores Claude agent aliases and falls back to Codex config", () => {
    expect(resolveCodexModel("sonnet", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveCodexModel("opus", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveCodexModel("haiku", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("omits unsupported Claude model names when no Codex fallback is configured", () => {
    expect(resolveCodexModel("claude-sonnet-4-5", null)).toBeNull();
    expect(resolveCodexModel("claude/opus", null)).toBeNull();
  });

  it("keeps explicit Codex-compatible model overrides", () => {
    expect(resolveCodexModel("gpt-5.6-sol", "gpt-5.1-codex")).toBe("gpt-5.6-sol");
    expect(resolveCodexModel(null, "gpt-5.1-codex")).toBe("gpt-5.1-codex");
  });
});

function installFakeCodex(
  script = "#!/bin/sh\necho startup failed >&2\nexit 42\n",
): { root: string; command: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "junior-codex-app-server-"));
  const binDir = join(root, "bin");
  const command = join(binDir, "codex");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(command, script.replaceAll("__ROOT__", JSON.stringify(root)));
  chmodSync(command, 0o755);
  return {
    root,
    command,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function recordingFakeCodexScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const root = __ROOT__;
const requestsPath = root + "/requests.jsonl";
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requestsPath, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "thread/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-created" } } });
  } else if (request.method === "turn/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-created" } } });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { thread: { id: "thread-created" }, finalResponse: "done" },
    });
    setTimeout(() => process.exit(0), 10);
  }
});
`;
}

function missingRolloutThenStartFakeCodexScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const root = __ROOT__;
const requestsPath = root + "/requests.jsonl";
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requestsPath, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "thread/resume") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32600,
        message: "no rollout found for thread id missing-thread",
      },
    });
  } else if (request.method === "thread/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-created" } } });
  } else if (request.method === "turn/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-created" } } });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { thread: { id: "thread-created" }, finalResponse: "done after fallback" },
    });
    setTimeout(() => process.exit(0), 10);
  }
});
`;
}

function approvalFakeCodexScript(
  method: string,
  extraParams: Record<string, unknown>,
): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const root = __ROOT__;
const requestsPath = root + "/requests.jsonl";
const rl = readline.createInterface({ input: process.stdin });
const method = ${JSON.stringify(method)};
const extraParams = ${JSON.stringify(extraParams)};

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requestsPath, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "thread/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-created" } } });
  } else if (request.method === "turn/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-created" } } });
    send({
      jsonrpc: "2.0",
      id: 900,
      method,
      params: {
        threadId: "thread-created",
        turnId: "turn-created",
        itemId: "item-approval",
        startedAtMs: 1,
        ...extraParams,
        ...(method === "item/permissions/requestApproval" ? { cwd: process.cwd() } : {}),
      },
    });
  } else if (request.id === 900) {
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { thread: { id: "thread-created" }, finalResponse: "done" },
    });
    setTimeout(() => process.exit(0), 10);
  }
});
`;
}

function exitingApprovalFakeCodexScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const root = __ROOT__;
const requestsPath = root + "/requests.jsonl";
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requestsPath, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "thread/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-created" } } });
  } else if (request.method === "turn/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-created" } } });
    send({
      jsonrpc: "2.0",
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-created",
        turnId: "turn-created",
        itemId: "item-approval",
        startedAtMs: 1,
        command: "git fetch",
      },
    });
    setTimeout(() => process.exit(17), 20);
  }
});
`;
}

const testConfig: Config = {
  slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "s" },
  claude: {
    maxTurns: 25,
    timeoutMs: 300000,
    permissionMode: "bypassPermissions",
    defaultModel: null,
    defaultDriver: "headless",
    tmuxIdleTtlMs: 14_400_000,
    tmuxSweepIntervalMs: 900_000,
  },
  runner: { provider: "codex-app-server" },
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
    mcpEnabled: false,
    slackMcpEnabled: false,
    playwrightMcpEnabled: false,
    mixpanelMcpEnabled: false,
    mongodbMcpEnabled: false,
    memoryMcpEnabled: false,
    isolatedHomePath: null,
  },
  repos: [],
  session: {
    staleTimeoutMs: 86400000,
    cleanupIntervalMs: 900000,
    store: "memory",
    sqlitePath: "data/sessions.db",
    homeWindowMs: 172800000,
    defaultVerbosity: "quiet",
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
