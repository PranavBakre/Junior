import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MockCodexToolCall {
  command: string;
  args?: string[];
}

export interface MockCodexProvider {
  command: string;
  root: string;
  readProtocolMessages(): Array<Record<string, unknown>>;
  readToolAttempts(): Array<Record<string, unknown>>;
  cleanup(): void;
}

/**
 * Installs a zero-network Codex app-server double that exercises tool calls.
 *
 * Unlike a protocol recorder, this provider reads the production thread policy,
 * attempts the configured command when the local environment is available,
 * and emits the same commandExecution lifecycle notifications consumed by the
 * real Codex adapter. Calls denied by `environments: []` are recorded but never
 * executed.
 */
export function installMockCodexProvider(tool: MockCodexToolCall): MockCodexProvider {
  const root = mkdtempSync(join(tmpdir(), "junior-mock-codex-provider-"));
  const binDir = join(root, "bin");
  const command = join(binDir, "codex");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(command, mockProviderScript(root, tool));
  chmodSync(command, 0o755);

  return {
    command,
    root,
    readProtocolMessages: () => readJsonLines(join(root, "protocol.jsonl")),
    readToolAttempts: () => readJsonLines(join(root, "tool-attempts.jsonl")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  try {
    const contents = readFileSync(path, "utf8").trim();
    if (!contents) return [];
    return contents.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function mockProviderScript(root: string, tool: MockCodexToolCall): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");
const root = ${JSON.stringify(root)};
const tool = ${JSON.stringify({ command: tool.command, args: tool.args ?? [] })};
const protocolPath = root + "/protocol.jsonl";
const attemptsPath = root + "/tool-attempts.jsonl";
const rl = readline.createInterface({ input: process.stdin });
let localEnvironmentAvailable = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function record(path, value) {
  fs.appendFileSync(path, JSON.stringify(value) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  record(protocolPath, request);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "thread/start") {
    localEnvironmentAvailable = !Object.prototype.hasOwnProperty.call(
      request.params,
      "environments",
    );
    send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "mock-thread" } } });
  } else if (request.method === "turn/start") {
    const item = {
      type: "commandExecution",
      command: [tool.command, ...tool.args].join(" "),
      cwd: request.params.cwd || process.cwd(),
      status: "in_progress",
    };
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "mock-turn" } } });
    send({
      jsonrpc: "2.0",
      method: "item/started",
      params: { threadId: "mock-thread", turnId: "mock-turn", item },
    });

    let attempt;
    if (localEnvironmentAvailable) {
      const result = spawnSync(tool.command, tool.args, {
        cwd: request.params.cwd || process.cwd(),
        encoding: "utf8",
      });
      attempt = {
        attempted: true,
        executed: result.error == null,
        exitCode: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        error: result.error ? result.error.message : null,
      };
    } else {
      attempt = {
        attempted: true,
        executed: false,
        exitCode: null,
        stdout: "",
        stderr: "local environment unavailable",
        error: "tool_unavailable",
      };
    }
    record(attemptsPath, attempt);

    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "mock-thread",
        turnId: "mock-turn",
        item: {
          ...item,
          status: attempt.executed && attempt.exitCode === 0 ? "completed" : "failed",
          aggregatedOutput: attempt.stdout + attempt.stderr,
          exitCode: attempt.exitCode,
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        thread: { id: "mock-thread" },
        turn: {
          id: "mock-turn",
          status: "completed",
          items: [{
            type: "agentMessage",
            text: attempt.executed ? "mock tool completed" : "mock tool unavailable",
          }],
        },
      },
    });
    setTimeout(() => process.exit(0), 10);
  }
});
`;
}
