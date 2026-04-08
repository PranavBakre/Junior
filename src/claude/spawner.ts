import type { Config } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "./types.ts";
import { buildClaudeArgs } from "./args.ts";
import { createStreamParser } from "./parser.ts";

export function spawnClaude(
  session: ThreadSession,
  prompt: string,
  config: Config["claude"],
  targetRepoCwd?: string,
): SpawnHandle {
  const args = buildClaudeArgs(session, prompt, config);
  const cwd = session.worktreePath ?? targetRepoCwd ?? process.cwd();

  const proc = Bun.spawn(["claude", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const listeners: Array<(event: StreamEvent) => void> = [];
  const events: StreamEvent[] = [];
  let sessionId: string | null = null;
  let response = "";

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

          if (event.type === "result") {
            response = event.text;
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
      response,
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
