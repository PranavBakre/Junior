import { resolve } from "node:path";
import type { Config } from "../config.ts";
import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type {
  RunnerCompletion,
  RunnerEvent,
  SpawnHandle,
  SpawnResult,
} from "../runners/types.ts";
import {
  buildRunnerRuntime,
  WORKFLOW_UTILITY_CWD,
} from "../runners/runtime.ts";
import {
  buildCodexMcpConfig,
  prepareCodexHome,
} from "./config.ts";
import { createCodexAppServerEventMapper } from "./parser.ts";
import { mapCodexRunPolicy } from "./policy.ts";
import { signalProcessTree } from "../lifecycle/process-tree.ts";
import { resolveTrustedSkill } from "../skills/registry.ts";
import { skillInvocationPrompt } from "../skills/runtime.ts";
import { requestSlackApproval } from "../mcp/slack-approval-bridge.ts";
import { subjectHasCapability } from "../agents/capabilities.ts";

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
  githubAuthEnv?: Record<string, string>,
): SpawnHandle {
  const provider = "codex-app-server" as const;
  const runtime = buildRunnerRuntime({
    session,
    targetRepoCwd,
    botToken,
    agentIdentity,
    githubAuthEnv,
  });
  const model = resolveCodexModel(session.model, config.codex.model);
  const policy = mapCodexRunPolicy({
    config: config.codex,
    session,
    cwd: runtime.cwd,
  });
  const mcp = buildCodexMcpConfig(config, session, policy.mcpAllowed);
  const activeSkill = session.activeSkill
    ? resolveTrustedSkill(session.activeSkill.name)
    : null;
  if (
    session.activeSkill &&
    (!activeSkill || activeSkill.path !== session.activeSkill.path)
  ) {
    throw new Error("active skill does not match Junior's trusted registry");
  }
  const codexHome = prepareCodexHome({
    isolatedHomePath: config.codex.isolatedHomePath ?? resolve(process.cwd(), "data/codex-home"),
    model,
    reasoningEffort: config.codex.reasoningEffort ?? "medium",
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
    detached: true,
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
  let acceptsServerResponses = true;
  const approvalControllers = new Set<AbortController>();

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

  const notify = (method: string, params: Record<string, unknown> = {}) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  const respond = (id: number, result: Record<string, unknown>): boolean => {
    if (!acceptsServerResponses || processExitError) return false;
    try {
      const write = proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      if (write instanceof Promise) {
        void write.catch((err) => {
          terminatePending(err instanceof Error ? err : new Error(String(err)));
        });
      }
      return true;
    } catch (err) {
      terminatePending(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  };

  const terminatePending = (err: Error) => {
    acceptsServerResponses = false;
    processExitError ??= err;
    for (const controller of approvalControllers) controller.abort();
    approvalControllers.clear();
    rejectPending(pending, processExitError);
  };

  proc.exited.then((exitCode) => {
    terminatePending(new Error(`Codex app-server exited before replying to pending requests (exit ${exitCode})`));
  }).catch(() => {
    terminatePending(new Error("Codex app-server exited before replying to pending requests"));
  });

  const stdoutDone = consumeStdout(proc.stdout, (message) => {
    if ("id" in message && typeof message.id === "number" && !("method" in message)) {
      settleResponse(message as unknown as JsonRpcResponse, pending);
      return;
    }

    if ("id" in message && typeof message.id === "number" && typeof message.method === "string") {
      const method = message.method;
      if (isApprovalRequestMethod(method)) {
        const controller = new AbortController();
        approvalControllers.add(controller);
        void requestSlackApproval({
          channel: session.channel,
          threadTs: session.threadId,
          agent: session.activeAgentName ?? session.agentType ?? "default",
          toolName: approvalToolName(method, message.params),
          input: message.params,
          signal: controller.signal,
        }).then((approved) => {
          respond(
            message.id as number,
            approvalResponse(method, message.params, approved),
          );
        }, () => {
          respond(
            message.id as number,
            approvalResponse(method, message.params, false),
          );
        }).finally(() => {
          approvalControllers.delete(controller);
        });
      } else {
        respond(message.id, responseForServerRequest(method));
      }
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
      notify("initialized");

      if (session.sessionId) {
        try {
          const resumed = record(await send("thread/resume", {
            threadId: session.sessionId,
            cwd: runtime.cwd,
            approvalPolicy: policy.approvalPolicy,
            sandbox: policy.sandbox,
            sandboxPolicy: policy.sandboxPolicy,
            ...codexEnvironmentSelection(session, runtime.cwd),
            developerInstructions: developerInstructions(session),
            excludeTurns: true,
            persistExtendedHistory: false,
          }));
          activeThreadId = stringValue(record(resumed?.thread)?.id) ?? session.sessionId;
        } catch (err) {
          if (!isMissingRolloutError(err)) throw err;
          activeThreadId = null;
        }
      }

      if (!activeThreadId) {
        const started = record(await send("thread/start", threadStartParams({
          cwd: runtime.cwd,
          model,
          policy,
          session,
        })));
        activeThreadId = stringValue(record(started?.thread)?.id);
        emitThreadStarted(activeThreadId, mapper.map, emit);
      }

      if (!activeThreadId) {
        throw new Error("Codex app-server did not return a thread id");
      }

      const turn = record(await send("turn/start", {
        threadId: activeThreadId,
        input: inputItems(
          activeSkill
            ? skillInvocationPrompt("codex", activeSkill, prompt)
            : prompt,
          imagePaths,
          activeSkill
            ? { name: activeSkill.name, path: activeSkill.path }
            : null,
        ),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
      }));
      activeTurnId = stringValue(record(turn?.turn)?.id);

      await waitForDone(events, proc.exited);
      processKilled = true;
      signalProcessTree(proc.pid, "SIGTERM");
      await stdoutDone;
      const exitCode = await proc.exited;
      const stderr = await stderrText;
      const effectiveExitCode = exitCode === 143 ? 0 : exitCode;
      const processError = mapper.error ?? (!mapper.response ? mapper.warning : null);
      const completion = mapper.completion ?? classifyCodexProcessCompletion(
        effectiveExitCode,
        processError,
      );
      const error = completion.status === "success"
        ? null
        : codexCompletionError(completion, processError ?? stderr);
      return {
        provider,
        sessionId: mapper.sessionId ?? activeThreadId,
        response: mapper.response,
        events,
        exitCode: effectiveExitCode,
        error,
        completion,
      };
    } catch (err) {
      if (!processKilled) signalProcessTree(proc.pid, "SIGTERM");
      const stderr = await stderrText;
      return {
        provider,
        sessionId: mapper.sessionId ?? activeThreadId,
        response: mapper.response,
        events,
        exitCode: await proc.exited.catch(() => null),
        error: err instanceof Error ? err.message : String(err || stderr),
        completion: {
          status: "failure",
          reason: "process_error",
          retryable: false,
          providerSubtype: "app-server-process",
        },
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
      acceptsServerResponses = false;
      for (const controller of approvalControllers) controller.abort();
      approvalControllers.clear();
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
          signalProcessTree(proc.pid, "SIGTERM");
        });
        return;
      }
      processKilled = true;
      signalProcessTree(proc.pid, signal ?? "SIGTERM");
    },
    pid: proc.pid,
  };
}

function classifyCodexProcessCompletion(
  exitCode: number | null,
  processError: string | null,
): RunnerCompletion {
  if (processError || (exitCode != null && exitCode !== 0)) {
    return {
      status: "failure",
      reason: "process_error",
      retryable: false,
      providerSubtype: "app-server-process",
    };
  }
  return {
    status: "incomplete",
    reason: "missing_result",
    retryable: true,
    providerSubtype: "app-server-process",
  };
}

function codexCompletionError(
  completion: RunnerCompletion,
  processError: string,
): string {
  if (processError.trim()) return processError.trim();
  if (completion.reason === "missing_result") {
    return "Codex app-server exited without a terminal turn/completed event.";
  }
  if (completion.reason === "interrupted") {
    return "Codex app-server interrupted the active turn before completion.";
  }
  return `Codex app-server invocation failed (${completion.providerSubtype ?? completion.reason}).`;
}

export function resolveCodexModel(
  sessionModel: string | null,
  configModel: string | null,
): string | null {
  const sessionCodexModel = codexCompatibleModel(sessionModel);
  if (sessionCodexModel) return sessionCodexModel;
  return codexCompatibleModel(configModel);
}

function codexCompatibleModel(model: string | null): string | null {
  if (!model) return null;

  // Private/public agent definitions historically used Claude shorthand
  // frontmatter (`sonnet`, `opus`, `haiku`) because agents first ran on the
  // Claude runner. Passing those aliases through to Codex app-server breaks
  // ChatGPT-authenticated Codex accounts with "model is not supported".
  // Treat them as runner-specific hints, not Codex overrides, and let Codex
  // use the configured/default model instead.
  if (/^(sonnet|opus|haiku)$/i.test(model)) return null;
  if (/^claude[-/]/i.test(model)) return null;

  return model;
}

function juniorBaselineInstructions(): string {
  return [
    "You are Junior running inside Codex as a Slack-controlled coding agent.",
    "Preserve Junior's Slack session semantics and respond with concise, useful final text.",
    "Do not use provider-native subagents. Junior owns fan-out through its durable assignment graph.",
  ].join("\n");
}

function developerInstructions(session: ThreadSession): string {
  return [
    juniorBaselineInstructions(),
    session.systemPrompt ??
      "Follow the active Junior agent instructions for this Slack thread.",
  ].join("\n\n");
}

function inputItems(
  prompt: string,
  imagePaths: string[],
  skill: { name: string; path: string } | null = null,
): Array<Record<string, unknown>> {
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...(skill
      ? [{ type: "skill", name: skill.name, path: skill.path }]
      : []),
    ...imagePaths.map((path) => ({ type: "localImage", path })),
  ];
}

function threadStartParams(options: {
  cwd: string;
  model: string | null;
  policy: ReturnType<typeof mapCodexRunPolicy>;
  session: ThreadSession;
}): Record<string, unknown> {
  return {
    cwd: options.cwd,
    model: options.model,
    approvalPolicy: options.policy.approvalPolicy,
    sandbox: options.policy.sandbox,
    sandboxPolicy: options.policy.sandboxPolicy,
    ...codexEnvironmentSelection(options.session, options.cwd),
    // Omit baseInstructions so Codex retains its native coding-agent operating
    // prompt. Junior is an additive developer layer, not a replacement for
    // Codex's tool, persistence, safety, and editing contract.
    developerInstructions: developerInstructions(options.session),
    ephemeral: false,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    threadSource: "user",
  };
}

function codexEnvironmentSelection(
  session: ThreadSession,
  cwd: string,
): { environments?: [] } {
  const worktreeRoots = [
    session.worktreePath,
    ...Object.values(session.worktreePaths ?? {}),
  ].filter((root): root is string => Boolean(root));
  if (
    subjectHasCapability(session, "worktree-verify") &&
    (worktreeRoots.includes(cwd) || cwd === WORKFLOW_UTILITY_CWD)
  ) {
    // Omission selects Codex's default local environment. The compiled
    // read-only/workspace sandbox remains authoritative for managed worktrees
    // and the fixed utility cwd used by trusted workflow definitions.
    return {};
  }
  // All other Junior sessions stay on the capability-scoped MCP surface.
  return { environments: [] };
}

function emitThreadStarted(
  threadId: string | null,
  map: (event: { method: string; params?: Record<string, unknown> }) => RunnerEvent[],
  emit: (event: RunnerEvent) => void,
): void {
  if (!threadId) return;
  for (const event of map({
    method: "thread/started",
    params: { thread: { id: threadId } },
  })) {
    emit(event);
  }
}

function isMissingRolloutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("no rollout found for thread id");
}

function responseForServerRequest(method: string): Record<string, unknown> {
  if (method === "item/tool/requestUserInput") return { input: null };
  if (method === "mcpServer/elicitation/request") {
    return { action: "accept", content: {}, _meta: null };
  }
  return {};
}

function approvalToolName(method: string, params: unknown): string {
  const payload = record(params);
  return stringValue(payload?.command) ?? stringValue(payload?.toolName) ?? method;
}

const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

function isApprovalRequestMethod(method: string): boolean {
  return APPROVAL_REQUEST_METHODS.has(method);
}

function approvalResponse(
  method: string,
  params: unknown,
  approved: boolean,
): Record<string, unknown> {
  if (method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval") {
    return { decision: approved ? "accept" : "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    const requested = record(params)?.permissions;
    return {
      permissions: approved && isRecord(requested) ? requested : {},
      scope: "turn",
    };
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
