import { resolve } from "node:path";
import type { Config } from "../config.ts";
import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type { ContentBlockToolUse, StreamEvent } from "./types.ts";
import type { RunnerEvent, SpawnHandle, SpawnResult } from "../runners/types.ts";
import { buildRunnerRuntime } from "../runners/runtime.ts";
import { buildClaudeArgs } from "./args.ts";
import { createStreamParser } from "./parser.ts";
import { signalProcessTree } from "../lifecycle/process-tree.ts";

// Junior's .mcp.json — pass to spawned processes so they find the slack-bot server
const PROJECT_MCP_CONFIG = resolve(import.meta.dirname ?? ".", "../../.mcp.json");

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
  const mcpConfigPath = runtime.needsProjectMcp ? PROJECT_MCP_CONFIG : undefined;
  const args = buildClaudeArgs(session, prompt, config, mcpConfigPath);

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
      console.error("[spawner] Error reading stdout:", err);
    }

    const exitCode = await proc.exited;

    let error: string | null = null;
    if (exitCode !== 0) {
      try {
        error = await new Response(proc.stderr).text();
      } catch {
        error = `Process exited with code ${exitCode}`;
      }
    }

    return {
      provider: "claude",
      sessionId,
      response: resultText || lastAssistantText,
      events,
      exitCode,
      error,
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
    case "result":
      return [{ type: "done", provider: "claude" }];
    default:
      return [];
  }
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
