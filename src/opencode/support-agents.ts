import { existsSync, readFileSync } from "node:fs";
import type { OpenCodeSubagentConfig } from "./config.ts";

const STATELESS_SUPPORT_AGENTS = [
  "nr-research",
  "sentry-fetch",
  "vercel-status",
] as const;

/**
 * OpenCode only sees agents declared in its effective config for the spawned
 * cwd. Junior's stateless observability prompts live under support/agents, not
 * .opencode/agents, so mirror them into generated OPENCODE_CONFIG_CONTENT.
 *
 * Deliberately do NOT expose persistent workers (reproducer/thinker/review)
 * here. Lead must dispatch those through Slack directives so they get their own
 * session, identity, and audit trail.
 */
export function loadOpenCodeSupportSubagents(): OpenCodeSubagentConfig[] {
  const agents: OpenCodeSubagentConfig[] = [];

  for (const name of STATELESS_SUPPORT_AGENTS) {
    const promptPath = new URL(
      `../../support/agents/${name}/prompt.md`,
      import.meta.url,
    );

    if (!existsSync(promptPath)) continue;

    agents.push({
      name,
      description: `Junior stateless support subagent: ${name}`,
      prompt: readFileSync(promptPath, "utf8").trim(),
    });
  }

  return agents;
}
