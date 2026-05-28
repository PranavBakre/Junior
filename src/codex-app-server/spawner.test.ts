import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { createSession } from "../session/types.ts";
import { spawnCodexAppServer } from "./spawner.ts";

const originalCodexBin = process.env.CODEX_BIN;

afterEach(() => {
  if (originalCodexBin == null) {
    delete process.env.CODEX_BIN;
  } else {
    process.env.CODEX_BIN = originalCodexBin;
  }
});

describe("spawnCodexAppServer", () => {
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
      expect(threadStart.params.sandbox).toBe("danger-full-access");
      expect(threadStart.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
      expect(turnStart.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
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
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 1000)),
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
        "thread/resume",
        "thread/start",
        "turn/start",
      ]);
      expect(requests.find((request) => request.method === "turn/start").params.threadId)
        .toBe("thread-created");
    } finally {
      fakeCodex.cleanup();
    }
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
  },
  memory: { sqlitePath: "data/memory.db" },
  threadArchives: { dir: "data/thread-archives" },
  channelDefaults: {},
  adminSlackUserId: null,
  http: { enabled: false, port: 0 },
};
