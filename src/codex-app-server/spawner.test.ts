import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});

function installFakeCodex(): { root: string; command: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "junior-codex-app-server-"));
  const binDir = join(root, "bin");
  const command = join(binDir, "codex");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(command, "#!/bin/sh\necho startup failed >&2\nexit 42\n");
  chmodSync(command, 0o755);
  return {
    root,
    command,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
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
  channelDefaults: {},
  adminSlackUserId: null,
  http: { enabled: false, port: 0 },
};
