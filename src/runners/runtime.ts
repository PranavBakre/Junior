import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
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

/**
 * Claude stores conversations under a cwd-derived project directory. A
 * session id that exists under one checkout is not resumable from another.
 * Unknown legacy affinity fails closed so the next turn establishes a fresh,
 * correctly-scoped provider session.
 */
export function providerSessionMatchesCwd(options: {
  provider: RunnerProvider;
  sessionId: string | null | undefined;
  sessionCwd: string | null | undefined;
  cwd: string;
}): boolean {
  if (!options.sessionId?.trim()) return true;
  if (options.provider !== "claude") return true;
  if (!options.sessionCwd?.trim()) return false;
  return normalizeProviderSessionCwd(options.sessionCwd) ===
    normalizeProviderSessionCwd(options.cwd);
}

export function normalizeProviderSessionCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function isProviderSessionUnavailable(
  provider: RunnerProvider,
  error: string | null | undefined,
): boolean {
  const normalized = (error ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  return provider === "claude" &&
    /No conversation found with session ID\b\s*:?/i.test(normalized);
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
  // MCP_CONTEXT_SECRET authenticates the agent identity embedded in MCP URLs.
  // A child that receives it could forge a different agent's capability token.
  delete env.MCP_CONTEXT_SECRET;
  // Database credentials belong to Junior's MCP backend, never to spawned
  // coding agents. Exposing them lets an unrestricted Bash session bypass the
  // read-only MCP surface with mongosh or a driver script.
  delete env.MDB_MCP_CONNECTION_STRING;
  delete env.DB_STRING;
  delete env.MONGODB_URI;
  delete env.MONGO_URI;
  delete env.MONGODB_URL;
  delete env.MONGO_URL;

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
