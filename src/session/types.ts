export interface PendingMessage {
  user: string;
  text: string;
  ts: string;
  command?: string;
  dedupeKey?: string;
}

export type AgentSessionStatus = "idle" | "busy" | "done" | "failed";

export interface AgentSession {
  agentName: string;
  sessionId: string | null;
  status: AgentSessionStatus;
  pendingMessages: PendingMessage[];
  lastActivity: number;
  pid: number | null;
  /**
   * Per-agent tmux session name. driverMode lives on the parent ThreadSession
   * (thread-level decision); only the unique tmux session name is per-agent.
   */
  tmuxSessionName?: string | null;
}

export interface AgentIdentity {
  username: string;
  iconEmoji: string;
}

export type SessionStatus = "idle" | "busy" | "draining";
export type SessionVerbosity = "quiet" | "normal" | "verbose";

/**
 * Mirror of `ClaudeDriver["mode"]`. Kept here as a string union to avoid
 * importing from `claude/` into `session/types.ts` (the dependency arrow
 * already runs the other way).
 */
export type DriverMode = "headless" | "tmux";

export interface ThreadSession {
  threadId: string;
  channel: string;
  sessionId: string | null;
  leadSessionId: string | null;
  agentSessions: Record<string, AgentSession>;
  worktreePath: string | null;
  /** Per-repo worktree paths for bug-pipeline threads. Keys are repo names (from RepoConfig.name). */
  worktreePaths: Record<string, string>;
  targetRepo: string | null;
  baseRef: string | null;
  agentType: string | null;
  systemPrompt: string | null;
  activeAgentName?: string;
  slackIdentity?: AgentIdentity;
  status: SessionStatus;
  pendingMessages: PendingMessage[];
  verbosity: SessionVerbosity;
  muted: boolean;
  model: string | null;
  cwd: string | null;
  pid: number | null;
  lastActivity: number;
  lastError: { type: string; message: string; timestamp: number } | null;
  createdAt: number;
  /** Thread-specific default agent override. When set, overrides channel default (e.g., lead in support channels). */
  defaultAgent?: "junior" | "lead" | null;
  /**
   * Which Claude driver runs this thread's turns. "headless" is the
   * historical default (`claude -p` per turn, billed as API credits under
   * the new Anthropic terms). "tmux" runs a persistent interactive TUI
   * inside a detached tmux session — stays under Max subscription.
   * Thread-level decision; per-agent sub-sessions inherit.
   */
  driverMode: DriverMode;
  /** Deterministic tmux session name for the top-level agent. Null until first tmux turn. */
  tmuxSessionName: string | null;
}

export function createSession(
  threadId: string,
  channel: string,
  defaultVerbosity: SessionVerbosity = "normal",
  driverMode: DriverMode = "headless",
): ThreadSession {
  return {
    threadId,
    channel,
    sessionId: null,
    leadSessionId: null,
    agentSessions: {},
    worktreePath: null,
    worktreePaths: {},
    targetRepo: null,
    baseRef: null,
    agentType: null,
    systemPrompt: null,
    status: "idle",
    pendingMessages: [],
    verbosity: defaultVerbosity,
    muted: false,
    model: null,
    cwd: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    driverMode,
    tmuxSessionName: null,
  };
}
