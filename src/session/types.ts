export interface PendingMessage {
  user: string;
  text: string;
  ts: string;
  command?: string;
  dedupeKey?: string;
}

export type AgentSessionStatus = "idle" | "busy" | "done" | "failed";
export type RunnerProvider = "claude" | "opencode" | "codex";

export function isRunnerProvider(value: unknown): value is RunnerProvider {
  return value === "claude" || value === "opencode" || value === "codex";
}

export function normalizeRunnerProvider(value: unknown): RunnerProvider {
  return isRunnerProvider(value) ? value : "claude";
}

export interface AgentSession {
  agentName: string;
  provider?: RunnerProvider;
  sessionId: string | null;
  status: AgentSessionStatus;
  pendingMessages: PendingMessage[];
  lastActivity: number;
  pid: number | null;
}

export interface AgentIdentity {
  username: string;
  iconEmoji: string;
}

export type SessionStatus = "idle" | "busy" | "draining";
export type SessionVerbosity = "quiet" | "normal" | "verbose";

export interface ThreadSession {
  threadId: string;
  channel: string;
  provider?: RunnerProvider;
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
}

export function createSession(
  threadId: string,
  channel: string,
  defaultVerbosity: SessionVerbosity = "normal",
  provider: RunnerProvider = "claude",
): ThreadSession {
  return {
    threadId,
    channel,
    provider,
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
  };
}
