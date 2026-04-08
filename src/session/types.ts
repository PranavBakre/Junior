export interface PendingMessage {
  user: string;
  text: string;
  ts: string;
  command?: string;
}

export type SessionStatus = "idle" | "busy" | "draining";

export interface ThreadSession {
  threadId: string;
  channel: string;
  sessionId: string | null;
  worktreePath: string | null;
  targetRepo: string | null;
  baseRef: string | null;
  agentType: string | null;
  systemPrompt: string | null;
  status: SessionStatus;
  pendingMessages: PendingMessage[];
  verbosity: "quiet" | "normal" | "verbose";
  pid: number | null;
  lastActivity: number;
  lastError: { type: string; message: string; timestamp: number } | null;
  createdAt: number;
}

export function createSession(
  threadId: string,
  channel: string
): ThreadSession {
  return {
    threadId,
    channel,
    sessionId: null,
    worktreePath: null,
    targetRepo: null,
    baseRef: null,
    agentType: null,
    systemPrompt: null,
    status: "idle",
    pendingMessages: [],
    verbosity: "normal",
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
  };
}
