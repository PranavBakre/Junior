import { mkdirSync } from "node:fs";
import type { AgentIdentity, ThreadSession } from "../session/types.ts";

export interface RunnerRuntimeOptions {
  session: ThreadSession;
  targetRepoCwd?: string;
  botToken?: string;
  agentIdentity?: AgentIdentity;
}

export interface RunnerRuntime {
  cwd: string;
  needsProjectMcp: boolean;
  env: Record<string, string>;
}

export function buildRunnerRuntime(options: RunnerRuntimeOptions): RunnerRuntime {
  const { session, targetRepoCwd, botToken, agentIdentity } = options;
  const cwd = resolveRunnerCwd(session, targetRepoCwd);
  if (session.cwd) mkdirSync(session.cwd, { recursive: true });

  return {
    cwd,
    needsProjectMcp: needsProjectMcp(session, cwd),
    env: buildRunnerEnv(session, botToken, agentIdentity),
  };
}

export function resolveRunnerCwd(
  session: ThreadSession,
  targetRepoCwd?: string,
): string {
  return session.cwd ?? session.worktreePath ?? targetRepoCwd ?? process.cwd();
}

export function needsProjectMcp(session: ThreadSession, cwd: string): boolean {
  // Claude-specific project .mcp.json policy: Claude auto-loads project MCPs
  // from Junior's root, so it only needs --mcp-config for off-root/worktree
  // runs. OpenCode generates its MCP config on every normal spawn and uses a
  // different predicate in src/opencode/spawner.ts.
  return !session.cwd && cwd !== process.cwd();
}

export function buildRunnerEnv(
  session: ThreadSession,
  botToken?: string,
  agentIdentity?: AgentIdentity,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    JUNIOR_SPAWNED: "1",
    SLACK_CHANNEL: session.channel,
    SLACK_THREAD_TS: session.threadId,
    JUNIOR_AGENT_NAME: session.activeAgentName ?? "lead",
    ...(botToken ? { SLACK_BOT_TOKEN: botToken } : {}),
  };

  if (agentIdentity) {
    env.JUNIOR_SLACK_USERNAME = agentIdentity.username;
    if (agentIdentity.iconEmoji) {
      env.JUNIOR_SLACK_ICON_EMOJI = agentIdentity.iconEmoji;
    } else {
      delete env.JUNIOR_SLACK_ICON_EMOJI;
    }
  } else {
    delete env.JUNIOR_SLACK_USERNAME;
    delete env.JUNIOR_SLACK_ICON_EMOJI;
  }

  return env;
}
