import { isPersistentAgent } from "./agents.ts";

export interface AgentDirective {
  agentName: string;
  prompt: string;
  line: string;
}

export function parseAgentDirectives(text: string): AgentDirective[] {
  const directives: AgentDirective[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^!(\S+)(?:\s+(.*))?$/);
    if (!match) continue;

    const agentName = match[1];
    if (!isPersistentAgent(agentName)) continue;

    directives.push({
      agentName,
      prompt: (match[2] ?? "").trim(),
      line,
    });
  }

  return directives;
}

export function parsePureAgentDirectiveResponse(text: string): AgentDirective[] {
  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonEmptyLines.length === 0) return [];

  const directives = parseAgentDirectives(nonEmptyLines.join("\n"));
  if (directives.length !== nonEmptyLines.length) return [];

  return directives;
}
