import type { Config } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";

export function buildClaudeArgs(
  session: ThreadSession,
  prompt: string,
  config: Config["claude"]
): string[] {
  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--max-turns",
    String(config.maxTurns),
  ];

  if (session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  if (session.systemPrompt) {
    args.push("--append-system-prompt", session.systemPrompt);
  }

  args.push("--permission-mode", config.permissionMode);

  return args;
}
