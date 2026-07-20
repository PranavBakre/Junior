import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.ts";
import { resolveEffectivePermissionIntent } from "../agents/loader.ts";
import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type { ContentBlockToolUse, StreamEvent, StreamEventResult } from "./types.ts";
import type {
  RunnerCompletion,
  RunnerEvent,
  SpawnHandle,
  SpawnResult,
} from "../runners/types.ts";
import { buildRunnerRuntime } from "../runners/runtime.ts";
import { buildClaudeArgs } from "./args.ts";
import { createStreamParser } from "./parser.ts";
import { signalProcessTree } from "../lifecycle/process-tree.ts";
import {
  mixpanelMcpCommand,
  mongoMcpUrl,
  needsUserSettings,
  playwrightMcpCommand,
  slackMcpUrl,
  wantsMcp,
} from "../runners/mcp-config.ts";

const MCP_CONFIG_DIR = resolve(import.meta.dirname ?? ".", "../../data/mcp-configs");

export function spawnClaude(
  session: ThreadSession,
  prompt: string,
  config: Config["claude"],
  targetRepoCwd?: string,
  botToken?: string,
  agentIdentity?: AgentIdentity,
): SpawnHandle {
  const runtime = buildRunnerRuntime({
    session,
    targetRepoCwd,
    botToken,
    agentIdentity,
  });
  // Human-gated agents route approvals through the slack-bot MCP permission
  // tool, so that server must be present even if the agent declared no MCP.
  const intent = resolveEffectivePermissionIntent(
    session.agentPermissions,
    session.activeAgentName ?? session.agentType,
  );
  const forceSlackMcp = config.approvalEnabled !== false && intent === "human-gated";
  const mcpConfigPath = shouldUseClaudeMcpConfig(session, runtime.needsProjectMcp, forceSlackMcp)
    ? writeClaudeMcpConfig(session, forceSlackMcp)
    : undefined;
  const effectiveConfig = needsUserSettings()
    ? widenSettingSources(config)
    : config;
  const args = buildClaudeArgs(session, prompt, effectiveConfig, runtime.cwd, mcpConfigPath);

  const proc = Bun.spawn(["claude", ...args], {
    cwd: runtime.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: runtime.env,
    detached: true,
  });

  const listeners: Array<(event: RunnerEvent) => void> = [];
  const events: RunnerEvent[] = [];
  let sessionId: string | null = null;
  let resultText = "";
  let lastAssistantText = "";
  let terminalResult: StreamEventResult | null = null;
  let streamError: string | null = null;

  const result = (async (): Promise<SpawnResult> => {
    const parser = createStreamParser();

    try {
      const reader = proc.stdout.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value);
        const parsed = parser.feed(chunk);

        for (const event of parsed) {
          const runnerEvents = mapClaudeEvent(event);

          if (event.type === "system" && event.subtype === "init") {
            sessionId = event.session_id;
          }

          if (event.type === "assistant") {
            // Track the last assistant turn's text (not accumulated across turns)
            let turnText = "";
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                turnText += block.text;
              }
            }
            if (turnText) {
              lastAssistantText = turnText;
            }
          }

          if (event.type === "result") {
            terminalResult = event;
            resultText = event.result ?? event.text ?? "";
          }

          for (const runnerEvent of runnerEvents) {
            events.push(runnerEvent);
            for (const listener of listeners) {
              try {
                listener(runnerEvent);
              } catch (err) {
                console.warn("[spawner] Event listener threw:", err);
              }
            }
          }
        }
      }
    } catch (err) {
      streamError = err instanceof Error ? err.message : String(err);
      console.error("[spawner] Error reading stdout:", err);
    }

    const exitCode = await proc.exited;

    let processError: string | null = streamError;
    if (exitCode !== 0) {
      try {
        processError = await new Response(proc.stderr).text();
      } catch {
        processError = `Process exited with code ${exitCode}`;
      }
    }

    const completion = classifyClaudeCompletion(
      terminalResult,
      exitCode,
      processError,
    );
    const error = completion.status === "success"
      ? null
      : claudeCompletionError(completion, processError);

    return {
      provider: "claude",
      sessionId,
      // Pipeline invocations suppress incomplete prose in the settlement
      // layer. Ordinary turns still need their last useful assistant text when
      // Claude reaches a turn cap or otherwise returns an incomplete result.
      response: selectClaudeResponse(resultText, lastAssistantText),
      events,
      exitCode,
      error,
      completion,
    };
  })();

  return {
    provider: "claude",
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

export function selectClaudeResponse(
  resultText: string,
  lastAssistantText: string,
): string {
  return resultText || lastAssistantText;
}

export function shouldUseClaudeMcpConfig(
  session: ThreadSession,
  _needsProjectMcp: boolean,
  _forceSlackMcp = false,
): boolean {
  if (session.cwd) return false;
  return true;
}

export function writeClaudeMcpConfig(
  session: ThreadSession,
  forceSlackMcp = false,
): string {
  mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  const agent = session.activeAgentName ?? "default";
  const path = join(MCP_CONFIG_DIR, `${session.threadId}-${agent}.json`);
  const mcpServers: Record<string, unknown> = {};
  if (forceSlackMcp || wantsMcp(session, "slack-bot")) {
    mcpServers["slack-bot"] = {
      type: "http",
      url: slackMcpUrl(session),
    };
  }
  if (wantsMcp(session, "playwright")) {
    mcpServers.playwright = playwrightMcpCommand();
  }
  if (wantsMcp(session, "mixpanel") && isFeatureMetricsSession(session)) {
    mcpServers.mixpanel = mixpanelMcpCommand();
  }
  if (wantsMcp(session, "mongodb")) {
    mcpServers.mongodb = {
      type: "http",
      url: mongoMcpUrl(session),
    };
  }
  mcpServers.figma = {
    type: "http",
    url: "https://mcp.figma.com/mcp",
  };
  mcpServers.notion = {
    type: "http",
    url: "https://mcp.notion.com/mcp",
  };
  const config = { mcpServers };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function isFeatureMetricsSession(session: ThreadSession): boolean {
  return (
    session.agentType === "feature-metrics" ||
    session.activeAgentName === "feature-metrics"
  );
}

export function mapClaudeEvent(event: StreamEvent): RunnerEvent[] {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        return [{
          type: "init",
          provider: "claude",
          sessionId: event.session_id,
        }];
      }
      return [];
    case "assistant": {
      const events: RunnerEvent[] = [];
      let text = "";
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          text += block.text;
        } else if (block.type === "tool_use") {
          events.push(mapClaudeToolUse(block));
        }
      }
      if (text) {
        events.unshift({ type: "message", provider: "claude", text });
      }
      return events;
    }
    case "result": {
      const usage = claudeDoneUsage(event);
      const completion = classifyClaudeCompletion(event, 0, null);
      return [{
        type: "done",
        provider: "claude",
        ...(usage ? { usage } : {}),
        completion,
      }];
    }
    default:
      return [];
  }
}

export function classifyClaudeCompletion(
  event: StreamEventResult | null,
  exitCode: number | null,
  processError: string | null,
): RunnerCompletion {
  if (exitCode !== 0 || processError) {
    return {
      status: "failure",
      reason: "process_error",
      retryable: false,
      ...(event?.subtype ? { providerSubtype: event.subtype } : {}),
      ...(event?.num_turns != null ? { turns: event.num_turns } : {}),
    };
  }
  if (!event) {
    return {
      status: "incomplete",
      reason: "missing_result",
      retryable: true,
    };
  }
  if (event.subtype === "success") {
    return {
      status: "success",
      reason: "completed",
      retryable: false,
      providerSubtype: event.subtype,
      ...(event.num_turns != null ? { turns: event.num_turns } : {}),
    };
  }
  if (event.subtype === "error_max_turns") {
    return {
      status: "incomplete",
      reason: "max_turns",
      retryable: true,
      providerSubtype: event.subtype,
      ...(event.num_turns != null ? { turns: event.num_turns } : {}),
    };
  }
  return {
    status: "failure",
    reason: "provider_error",
    retryable: false,
    providerSubtype: event.subtype,
    ...(event.num_turns != null ? { turns: event.num_turns } : {}),
  };
}

function claudeCompletionError(
  completion: RunnerCompletion,
  processError: string | null,
): string {
  if (processError?.trim()) return processError.trim();
  if (completion.reason === "max_turns") {
    return `Claude reached its ${completion.turns ?? "configured"} turn limit before completing the invocation.`;
  }
  if (completion.reason === "missing_result") {
    return "Claude exited without a terminal result event.";
  }
  return `Claude invocation failed (${completion.providerSubtype ?? completion.reason}).`;
}

function claudeDoneUsage(
  event: StreamEventResult,
): Record<string, unknown> | undefined {
  const usage: Record<string, unknown> = {};
  if (event.total_cost_usd != null) usage.total_cost_usd = event.total_cost_usd;
  if (event.usage) usage.usage = event.usage;
  if (event.num_turns != null) usage.num_turns = event.num_turns;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function widenSettingSources(config: Config["claude"]): Config["claude"] {
  const base = config.settingSources ?? "";
  if (!base || base.includes("user")) return config;
  return { ...config, settingSources: `user,${base}` };
}

function mapClaudeToolUse(block: ContentBlockToolUse): RunnerEvent {
  return {
    type: "tool",
    provider: "claude",
    name: block.name ?? "Unknown",
    input: block.input ?? {},
    status: "started",
  };
}
