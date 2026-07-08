import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type { RunnerEvent, SpawnHandle, SpawnResult } from "../runners/types.ts";
import { buildRunnerRuntime } from "../runners/runtime.ts";
import { buildOpenCodeArgs } from "./args.ts";
import { resolveOpenCodeModel } from "./model.ts";
import {
  buildOpenCodeConfigContent,
  type OpenCodeMcpConfig,
  type OpenCodePermissionConfig,
  type OpenCodeSubagentConfig,
} from "./config.ts";
import {
  createOpenCodeEventMapper,
  createOpenCodeStreamParser,
  type OpenCodeEvent,
} from "./parser.ts";
import { buildOpenCodeAgentPrompt, OPENCODE_PROVIDER_AGENT } from "./prompt.ts";
import { loadOpenCodeSupportSubagents } from "./support-agents.ts";
import { signalProcessTree } from "../lifecycle/process-tree.ts";

export interface OpenCodeEnvContext {
  session: ThreadSession;
  cwd: string;
  agentName: string;
  juniorAgentName: string;
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
  continuityEnabled?: boolean;
  permission?: OpenCodePermissionConfig;
  mcp?: OpenCodeMcpConfig | null;
  subagents?: OpenCodeSubagentConfig[];
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
  const juniorAgentName = juniorAgentNameForSession(session);
  const agentName = config.agentName ?? OPENCODE_PROVIDER_AGENT;
  const model = resolveOpenCodeModel(session.model, config.defaultModel);
  const agentPrompt = buildOpenCodeAgentPrompt({
    juniorAgentName,
    juniorPrompt: config.agentPrompt ?? session.systemPrompt,
  });
  const configContent = buildOpenCodeConfigContent({
    agentName,
    agentPrompt,
    description: config.description,
    model,
    permission: config.permission,
    // OpenCode receives MCP via generated config, not Claude's project
    // .mcp.json. Keep the utility cwd carve-out (calendar/cloud utilities rely
    // on their own integrations), but all normal Junior/lead/worker runs need
    // Slack MCP even when cwd is Junior's project root so intake can call
    // register_worktree before any worktree exists.
    mcp: session.cwd ? null : config.mcp,
    subagents: session.cwd
      ? []
      : (config.subagents ?? loadOpenCodeSupportSubagents()),
  });
  const env = extendOpenCodeEnv(
    {
      ...runtime.env,
      OPENCODE_CONFIG_CONTENT: configContent,
    },
    config.env,
    { session, cwd: runtime.cwd, agentName, juniorAgentName },
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
    sessionId: config.continuityEnabled ? session.sessionId : null,
    model,
    files: imagePaths,
  });

  const proc = Bun.spawn([config.command ?? "opencode", ...args], {
    cwd: runtime.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
    detached: true,
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
    // Prefer OpenCode's own native error event (parsed off stdout) when present:
    // opencode's embedded server reports failures as a `{"type":"error",...}`
    // event and exits 1 with an empty stderr, so the generic exit-code string is
    // useless. Fall back to the original stderr/stdout/generic chain otherwise.
    const error =
      exitCode === 0
        ? stdoutError
        : (mapper.error ?? (stderr || stdoutError || `Process exited with code ${exitCode}`));

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
    kill: (signal) => {
      signalProcessTree(proc.pid, signal ?? "SIGTERM");
    },
    pid: proc.pid,
  };
}

function juniorAgentNameForSession(session: ThreadSession): string {
  return session.agentType ?? session.activeAgentName ?? "default";
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
