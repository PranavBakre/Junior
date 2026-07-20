import { mkdirSync } from "node:fs";
import type { AgentIdentity, RunnerProvider, ThreadSession } from "../session/types.ts";

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

/**
 * Whether this provider invocation will resume a prior model session.
 *
 * Prompt construction must inject bounded thread/assignment/artifact/memory
 * context whenever this returns false — a stored session ID alone is not proof
 * of resume when the provider has continuity disabled (OpenCode default).
 */
export function willResume(options: {
  provider: RunnerProvider;
  sessionId: string | null | undefined;
  opencodeContinuityEnabled: boolean;
}): boolean {
  const sessionId = options.sessionId?.trim();
  if (!sessionId) return false;

  switch (options.provider) {
    case "opencode":
    case "opencode-sdk":
      return options.opencodeContinuityEnabled;
    case "claude":
    case "codex":
    case "codex-app-server":
      return true;
    default: {
      const _exhaustive: never = options.provider;
      return _exhaustive;
    }
  }
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
      delete env.JUNIOR_SLACK_ICON_URL;
    } else if (agentIdentity.imageUrl) {
      env.JUNIOR_SLACK_ICON_URL = agentIdentity.imageUrl;
      delete env.JUNIOR_SLACK_ICON_EMOJI;
    } else {
      delete env.JUNIOR_SLACK_ICON_EMOJI;
      delete env.JUNIOR_SLACK_ICON_URL;
    }
  } else {
    delete env.JUNIOR_SLACK_USERNAME;
    delete env.JUNIOR_SLACK_ICON_EMOJI;
    delete env.JUNIOR_SLACK_ICON_URL;
  }

  return env;
}
