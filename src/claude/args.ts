import type { Config } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";

export function buildClaudeArgs(
  session: ThreadSession,
  prompt: string,
  config: Config["claude"],
  mcpConfigPath?: string,
): string[] {
  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(config.maxTurns),
  ];

  if (session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  if (session.systemPrompt) {
    args.push("--append-system-prompt", session.systemPrompt);
  }

  const model = session.model ?? config.defaultModel;
  if (model) {
    args.push("--model", model);
  }

  args.push("--permission-mode", config.permissionMode);

  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  return args;
}
