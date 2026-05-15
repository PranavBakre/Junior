import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type { RunnerEvent, SpawnHandle, SpawnResult } from "../runners/types.ts";
import { buildRunnerRuntime } from "../runners/runtime.ts";
import { buildOpenCodeArgs } from "./args.ts";
import {
  buildOpenCodeConfigContent,
  type OpenCodeMcpConfig,
  type OpenCodePermissionConfig,
} from "./config.ts";
import {
  createOpenCodeEventMapper,
  createOpenCodeStreamParser,
  type OpenCodeEvent,
} from "./parser.ts";
import { buildOpenCodeAgentPrompt } from "./prompt.ts";

export interface OpenCodeEnvContext {
  session: ThreadSession;
  cwd: string;
  agentName: string;
}

export type OpenCodeEnvExtension =
  | Record<string, string | undefined>
  | ((
      env: Record<string, string>,
      context: OpenCodeEnvContext,
    ) => Record<string, string | undefined> | void);

export interface OpenCodeSpawnerConfig {
  command?: string;
  agentName?: string;
  agentPrompt?: string;
  description?: string;
  defaultModel?: string | null;
  permission?: OpenCodePermissionConfig;
  mcp?: OpenCodeMcpConfig | null;
  env?: OpenCodeEnvExtension;
}

export function spawnOpenCode(
  session: ThreadSession,
  prompt: string,
  config: OpenCodeSpawnerConfig = {},
  targetRepoCwd?: string,
  botToken?: string,
  agentIdentity?: AgentIdentity,
  imagePaths: string[] = [],
): SpawnHandle {
  const runtime = buildRunnerRuntime({
    session,
    targetRepoCwd,
    botToken,
    agentIdentity,
  });
  const agentName = config.agentName ?? "build";
  const model = session.model ?? config.defaultModel ?? null;
  const agentPrompt = buildOpenCodeAgentPrompt({
    juniorPrompt: config.agentPrompt ?? session.systemPrompt,
  });
  const configContent = buildOpenCodeConfigContent({
    agentName,
    agentPrompt,
    description: config.description,
    model,
    permission: config.permission,
    mcp: runtime.needsProjectMcp ? config.mcp : null,
  });
  const env = extendOpenCodeEnv(
    {
      ...runtime.env,
      OPENCODE_CONFIG_CONTENT: configContent,
    },
    config.env,
    { session, cwd: runtime.cwd, agentName },
  );
  // OpenCode merges configs across layers (global, OPENCODE_CONFIG, project,
  // OPENCODE_CONFIG_CONTENT). A developer's shell-set OPENCODE_CONFIG would
  // load before Junior's inline config and contribute keys we don't override.
  // Drop it so the only operator-supplied surface is the global rcfile.
  delete env.OPENCODE_CONFIG;
  const args = buildOpenCodeArgs({
    cwd: runtime.cwd,
    agentName,
    prompt,
    sessionId: session.sessionId,
    model,
    files: imagePaths,
  });

  const proc = Bun.spawn([config.command ?? "opencode", ...args], {
    cwd: runtime.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
  });

  const listeners: Array<(event: RunnerEvent) => void> = [];
  const events: RunnerEvent[] = [];
  const stderrText = readStream(proc.stderr);

  const result = (async (): Promise<SpawnResult> => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const decoder = new TextDecoder();
    let stdoutError: string | null = null;

    try {
      const reader = proc.stdout.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        emitMappedEvents(parser.feed(decoder.decode(value)), mapper, events, listeners);
      }

      emitMappedEvents(parser.flush(), mapper, events, listeners);
    } catch (err) {
      stdoutError = err instanceof Error ? err.message : String(err);
    }

    const exitCode = await proc.exited;
    const stderr = await stderrText;
    const error =
      exitCode === 0
        ? stdoutError
        : stderr || stdoutError || `Process exited with code ${exitCode}`;

    return {
      provider: "opencode",
      sessionId: mapper.sessionId,
      response: mapper.response,
      events,
      exitCode,
      error,
    };
  })();

  return {
    provider: "opencode",
    result,
    onEvent: (cb) => {
      listeners.push(cb);
    },
    kill: () => {
      proc.kill();
    },
    pid: proc.pid,
  };
}

function emitMappedEvents(
  nativeEvents: OpenCodeEvent[],
  mapper: ReturnType<typeof createOpenCodeEventMapper>,
  events: RunnerEvent[],
  listeners: Array<(event: RunnerEvent) => void>,
): void {
  for (const nativeEvent of nativeEvents) {
    for (const runnerEvent of mapper.map(nativeEvent)) {
      events.push(runnerEvent);
      for (const listener of listeners) {
        try {
          listener(runnerEvent);
        } catch (err) {
          console.warn("[opencode] Event listener threw:", err);
        }
      }
    }
  }
}

function extendOpenCodeEnv(
  baseEnv: Record<string, string>,
  extension: OpenCodeEnvExtension | undefined,
  context: OpenCodeEnvContext,
): Record<string, string> {
  const env = { ...baseEnv };
  const extra =
    typeof extension === "function" ? extension(env, context) : extension;

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }

  return env;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}
