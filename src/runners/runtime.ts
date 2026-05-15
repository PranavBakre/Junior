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
  return !session.cwd && cwd !== process.cwd();
}

export function buildRunnerEnv(
  session: ThreadSession,
  botToken?: string,
  agentIdentity?: AgentIdentity,
): Record<string, string> {
  return {
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
  };
}
