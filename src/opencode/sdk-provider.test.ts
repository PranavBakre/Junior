import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../session/types.ts";
import { spawnOpenCodeSdk } from "./sdk-provider.ts";
import type { Config } from "../config.ts";

interface MockSdkController {
  createOpencode(options?: { directory?: string }): Promise<{
    client: {
      session: {
        create(args?: { directory?: string; agent?: string }): Promise<{ id: string }>;
        prompt(args: { sessionID: string; message: { role: string; parts: Array<{ type: string; text?: string }> } }): Promise<unknown>;
        abort(args: { sessionID: string }): Promise<unknown>;
      };
      event: {
        subscribe(args: { directory?: string }): AsyncIterable<{ data: string }>;
      };
      config: {
        update(args: { config: Record<string, unknown> }): Promise<unknown>;
      };
    };
    server: { url: string; close(): void };
  }>;
}

type GlobalWithSdkMock = typeof globalThis & {
  __juniorOpenCodeSdkMock?: MockSdkController;
};

const originalOpenCodeBin = process.env.OPENCODE_BIN;

afterEach(() => {
  if (originalOpenCodeBin == null) {
    delete process.env.OPENCODE_BIN;
  } else {
    process.env.OPENCODE_BIN = originalOpenCodeBin;
  }
  delete (globalThis as GlobalWithSdkMock).__juniorOpenCodeSdkMock;
});

describe("spawnOpenCodeSdk", () => {
  it("resolves on the active session step-finish without waiting for the server event stream to close", async () => {
    const fakeSdk = installFakeSdk();
    process.env.OPENCODE_BIN = fakeSdk.opencodeBin;

    (globalThis as GlobalWithSdkMock).__juniorOpenCodeSdkMock = {
      createOpencode: async () => ({
        client: {
          session: {
            create: async () => ({ id: "ses_active" }),
            prompt: async () => ({}),
            abort: async () => ({}),
          },
          event: {
            subscribe: async function* () {
              yield { data: JSON.stringify({ type: "text", sessionID: "ses_other", text: "wrong" }) };
              yield { data: JSON.stringify({ type: "step-finish", sessionID: "ses_other" }) };
              yield { data: JSON.stringify({ type: "text", sessionID: "ses_active", text: "right" }) };
              yield { data: JSON.stringify({ type: "step-finish", sessionID: "ses_active" }) };
              await new Promise<never>(() => undefined);
            },
          },
          config: { update: async () => ({}) },
        },
        server: { url: "http://localhost:0", close: () => undefined },
      }),
    };

    try {
      const session = createSession("thread-1", "C01");
      session.provider = "opencode-sdk";
      const handle = spawnOpenCodeSdk(session, "work", testConfig);
      const result = await Promise.race([
        handle.result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 100)),
      ]);

      expect(result.sessionId).toBe("ses_active");
      expect(result.response).toBe("right");
      expect(result.events.map((event) => event.type)).toEqual(["init", "message", "done"]);
    } finally {
      fakeSdk.cleanup();
    }
  });
});

function installFakeSdk(): { opencodeBin: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "junior-opencode-sdk-"));
  const binDir = join(root, "bin");
  const sdkDir = join(root, "node_modules", "@opencode-ai", "sdk");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(sdkDir, { recursive: true });

  const opencodeBin = join(binDir, "opencode");
  writeFileSync(opencodeBin, "#!/bin/sh\nexit 0\n");
  chmodSync(opencodeBin, 0o755);
  writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  writeFileSync(
    join(sdkDir, "index.js"),
    "export async function createOpencode(options) { return globalThis.__juniorOpenCodeSdkMock.createOpencode(options); }\n",
  );

  return {
    opencodeBin,
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
  runner: { provider: "opencode-sdk" },
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
