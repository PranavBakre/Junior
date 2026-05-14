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
  /**
   * Auto-dormant when humans are talking to each other without addressing
   * Junior. Set by the attention gate; cleared by @mention or `!listen`.
   * Persists across restarts so a sidebar doesn't auto-resume.
   */
  dormant: boolean;
  /**
   * Sticky: set once when the attention gate fires its one-shot announcement
   * for this thread, and never reset. Suppresses re-trigger thrashing after
   * the human takes manual action (`!listen` / @mention). If they want to
   * re-silence, that's `!aside` or `!mute`, not another auto-trigger.
   */
  dormantAnnounced: boolean;
  /**
   * Slack user IDs of humans who have posted in this thread (order of first
   * post). Bots — Junior, its agents, foreign bots — are never recorded. Used
   * by the attention gate to detect human-to-human sidebar.
   *
   * The gate only needs "is there any other human besides the current
   * sender?" — an `O(1)` boolean would do the same work with bounded storage.
   * The array carries names because (a) it's observable in `!status`, useful
   * for debugging false triggers; (b) bounded in practice by channel
   * membership; (c) leaves room for future per-user policy (e.g. wake only
   * for the thread opener) without a data-shape migration.
   */
  humanParticipants: string[];
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
    dormant: false,
    dormantAnnounced: false,
    humanParticipants: [],
    model: null,
    cwd: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
  };
}
