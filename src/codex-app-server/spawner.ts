import { resolve } from "node:path";
import type { Config } from "../config.ts";
import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type { RunnerEvent, SpawnHandle, SpawnResult } from "../runners/types.ts";
import { buildRunnerRuntime } from "../runners/runtime.ts";
import {
  buildCodexMcpConfig,
  prepareCodexHome,
} from "./config.ts";
import { createCodexAppServerEventMapper } from "./parser.ts";
import { mapCodexRunPolicy } from "./policy.ts";

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export function spawnCodexAppServer(
  session: ThreadSession,
  prompt: string,
  config: Config,
  targetRepoCwd?: string,
  botToken?: string,
  agentIdentity?: AgentIdentity,
  imagePaths: string[] = [],
): SpawnHandle {
  const provider = "codex-app-server" as const;
  const runtime = buildRunnerRuntime({
    session,
    targetRepoCwd,
    botToken,
    agentIdentity,
  });
  const model = session.model ?? config.codex.model ?? null;
  const policy = mapCodexRunPolicy({
    config: config.codex,
    session,
    cwd: runtime.cwd,
  });
  const mcp = buildCodexMcpConfig(config, session, policy.mcpAllowed);
  const codexHome = prepareCodexHome({
    isolatedHomePath: config.codex.isolatedHomePath ?? resolve(process.cwd(), "data/codex-home"),
    model,
    approvalPolicy: config.codex.askForApproval,
    sandbox: config.codex.sandbox,
    mcp,
    trustedProjectPath: runtime.cwd,
  });

  const env = {
    ...runtime.env,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
  };

  const proc = Bun.spawn([process.env.CODEX_BIN ?? "codex", "app-server", "--listen", "stdio://"], {
    cwd: runtime.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env,
  });

  const listeners: Array<(event: RunnerEvent) => void> = [];
  const events: RunnerEvent[] = [];
  const mapper = createCodexAppServerEventMapper();
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let activeThreadId: string | null = session.sessionId;
  let activeTurnId: string | null = null;
  let processKilled = false;
  let processExitError: Error | null = null;

  const emit = (event: RunnerEvent) => {
    events.push(event);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[codex-app-server] Event listener threw:", err);
      }
    }
  };

  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      if (processExitError) {
        pending.delete(id);
        reject(processExitError);
        return;
      }
      try {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const respond = (id: number, result: Record<string, unknown>) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };

  proc.exited.then((exitCode) => {
    processExitError = new Error(`Codex app-server exited before replying to pending requests (exit ${exitCode})`);
    rejectPending(pending, processExitError);
  }).catch(() => {
    processExitError = new Error("Codex app-server exited before replying to pending requests");
    rejectPending(pending, processExitError);
  });

  const stdoutDone = consumeStdout(proc.stdout, (message) => {
    if ("id" in message && typeof message.id === "number" && !("method" in message)) {
      settleResponse(message as unknown as JsonRpcResponse, pending);
      return;
    }

    if ("id" in message && typeof message.id === "number" && typeof message.method === "string") {
      respond(message.id, responseForServerRequest(message.method));
      return;
    }

    if (typeof message.method === "string") {
      if (message.method === "turn/started") {
        const turn = record(record(message.params)?.turn);
        activeTurnId = stringValue(turn?.id);
      }
      if (message.method === "turn/completed") {
        activeTurnId = null;
      }
      for (const event of mapper.map({
        method: message.method,
        params: record(message.params),
      })) {
        emit(event);
      }
    }
  });
  const stderrText = readStream(proc.stderr);

  const result = (async (): Promise<SpawnResult> => {
    try {
      await send("initialize", {
        clientInfo: {
          name: "junior-codex-app-server",
          title: "Junior Codex app-server provider",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });

      if (session.sessionId) {
        const resumed = record(await send("thread/resume", {
          threadId: session.sessionId,
          cwd: runtime.cwd,
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          sandboxPolicy: policy.sandboxPolicy,
          developerInstructions: developerInstructions(session),
          excludeTurns: true,
          persistExtendedHistory: false,
        }));
        activeThreadId = stringValue(record(resumed?.thread)?.id) ?? session.sessionId;
      } else {
        const started = record(await send("thread/start", {
          cwd: runtime.cwd,
          model,
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          sandboxPolicy: policy.sandboxPolicy,
          baseInstructions: baseInstructions(),
          developerInstructions: developerInstructions(session),
          ephemeral: false,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          threadSource: "user",
        }));
        activeThreadId = stringValue(record(started?.thread)?.id);
        if (activeThreadId) {
          for (const event of mapper.map({
            method: "thread/started",
            params: { thread: { id: activeThreadId } },
          })) {
            emit(event);
          }
        }
      }

      if (!activeThreadId) {
        throw new Error("Codex app-server did not return a thread id");
      }

      const turn = record(await send("turn/start", {
        threadId: activeThreadId,
        input: inputItems(prompt, imagePaths),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
      }));
      activeTurnId = stringValue(record(turn?.turn)?.id);

      await waitForDone(events, proc.exited);
      processKilled = true;
      proc.kill("SIGTERM");
      await stdoutDone;
      const exitCode = await proc.exited;
      const stderr = await stderrText;
      const mapperError = mapper.error ?? (!mapper.response ? mapper.warning : null);
      return {
        provider,
        sessionId: mapper.sessionId ?? activeThreadId,
        response: mapper.response,
        events,
        exitCode: exitCode === 143 ? 0 : exitCode,
        error: mapperError ?? (exitCode === 0 || exitCode === 143 ? null : stderr || `Process exited with code ${exitCode}`),
      };
    } catch (err) {
      if (!processKilled) proc.kill("SIGTERM");
      const stderr = await stderrText;
      return {
        provider,
        sessionId: mapper.sessionId ?? activeThreadId,
        response: mapper.response,
        events,
        exitCode: await proc.exited.catch(() => null),
        error: err instanceof Error ? err.message : String(err || stderr),
      };
    }
  })();

  return {
    provider,
    result,
    onEvent: (cb) => {
      listeners.push(cb);
    },
    kill: (signal) => {
      if (
        signal === "SIGINT" &&
        config.codex.appServerContinuityEnabled &&
        activeThreadId &&
        activeTurnId
      ) {
        void send("turn/interrupt", {
          threadId: activeThreadId,
          turnId: activeTurnId,
        }).catch(() => {
          proc.kill("SIGTERM");
        });
        return;
      }
      processKilled = true;
      proc.kill(signal ?? "SIGTERM");
    },
    pid: proc.pid,
  };
}

function baseInstructions(): string {
  return [
    "You are Junior running inside Codex as a Slack-controlled coding agent.",
    "Preserve Junior's Slack session semantics and respond with concise, useful final text.",
    "Use provider-native subagents only when the task or active Junior agent prompt explicitly asks for delegation or parallel agent work.",
  ].join("\n");
}

function developerInstructions(session: ThreadSession): string {
  return session.systemPrompt ?? "Follow the active Junior agent instructions for this Slack thread.";
}

function inputItems(prompt: string, imagePaths: string[]): Array<Record<string, unknown>> {
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...imagePaths.map((path) => ({ type: "localImage", path })),
  ];
}

function responseForServerRequest(method: string): Record<string, unknown> {
  if (method.includes("requestApproval")) return { approved: false };
  if (method === "item/tool/requestUserInput") return { input: null };
  if (method === "mcpServer/elicitation/request") {
    return { action: "accept", content: {}, _meta: null };
  }
  return {};
}

async function consumeStdout(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: Record<string, unknown>) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) {
        try {
          const parsed = JSON.parse(line);
          if (isRecord(parsed)) onMessage(parsed);
        } catch {
          // stderr carries protocol diagnostics; ignore non-JSON stdout.
        }
      }
      newlineIdx = buffer.indexOf("\n");
    }
  }
}

function settleResponse(response: JsonRpcResponse, pending: Map<number, PendingRequest>): void {
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  if (response.error) {
    entry.reject(new Error(`${entry.method}: ${JSON.stringify(response.error)}`));
  } else {
    entry.resolve(response.result);
  }
}

function rejectPending(pending: Map<number, PendingRequest>, err: Error): void {
  for (const entry of pending.values()) {
    entry.reject(err);
  }
  pending.clear();
}

async function waitForDone(events: RunnerEvent[], exited: Promise<number>): Promise<void> {
  while (!events.some((event) => event.type === "done")) {
    const exit = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (exit) return;
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
