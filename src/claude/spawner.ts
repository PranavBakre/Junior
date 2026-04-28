import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "../config.ts";
import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "./types.ts";
import { buildClaudeArgs } from "./args.ts";
import { createStreamParser } from "./parser.ts";

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
  const cwd = session.cwd ?? session.worktreePath ?? targetRepoCwd ?? process.cwd();
  if (session.cwd) mkdirSync(session.cwd, { recursive: true });
  // Pass MCP config for worktree/target repo so they find the slack-bot server.
  // Skip for session.cwd overrides (utility commands) — they need cloud integrations, not local MCP.
  const needsMcpConfig = !session.cwd && cwd !== process.cwd();
  const mcpConfigPath = needsMcpConfig ? PROJECT_MCP_CONFIG : undefined;
  const args = buildClaudeArgs(session, prompt, config, mcpConfigPath);

  const proc = Bun.spawn(["claude", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      JUNIOR_SPAWNED: "1",
      SLACK_CHANNEL: session.channel,
      SLACK_THREAD_TS: session.threadId,
      JUNIOR_AGENT_NAME: session.activeAgentName ?? "lead",
      ...(agentIdentity
        ? {
            JUNIOR_SLACK_USERNAME: agentIdentity.username,
            JUNIOR_SLACK_ICON_EMOJI: agentIdentity.iconEmoji,
          }
        : {}),
      ...(botToken ? { SLACK_BOT_TOKEN: botToken } : {}),
    },
  });

  const listeners: Array<(event: StreamEvent) => void> = [];
  const events: StreamEvent[] = [];
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
          events.push(event);

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

          for (const listener of listeners) {
            try {
              listener(event);
            } catch (err) {
              console.warn("[spawner] Event listener threw:", err);
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
      sessionId,
      response: resultText || lastAssistantText,
      events,
      exitCode,
      error,
    };
  })();

  return {
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
