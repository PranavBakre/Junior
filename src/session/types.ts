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
  sessionId: string | null;
  leadSessionId: string | null;
  agentSessions: Record<string, AgentSession>;
  worktreePath: string | null;
  targetRepo: string | null;
  baseRef: string | null;
  agentType: string | null;
  systemPrompt: string | null;
  activeAgentName?: string;
  slackIdentity?: AgentIdentity;
  status: SessionStatus;
  pendingMessages: PendingMessage[];
  verbosity: SessionVerbosity;
  model: string | null;
  cwd: string | null;
  pid: number | null;
  lastActivity: number;
  lastError: { type: string; message: string; timestamp: number } | null;
  createdAt: number;
}

export function createSession(
  threadId: string,
  channel: string,
  defaultVerbosity: SessionVerbosity = "normal",
): ThreadSession {
  return {
    threadId,
    channel,
    sessionId: null,
    leadSessionId: null,
    agentSessions: {},
    worktreePath: null,
    targetRepo: null,
    baseRef: null,
    agentType: null,
    systemPrompt: null,
    status: "idle",
    pendingMessages: [],
    verbosity: defaultVerbosity,
    model: null,
    cwd: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
  };
}
