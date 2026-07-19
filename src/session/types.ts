export interface PendingMessage {
  user: string;
  text: string;
  ts: string;
  command?: string;
  dedupeKey?: string;
}

export type AgentSessionStatus = "idle" | "busy" | "done" | "failed";
export type RunnerProvider =
  | "claude"
  | "opencode"
  | "opencode-sdk"
  | "codex-app-server"
  | "codex";
export type ImplementedRunnerProvider = Exclude<RunnerProvider, "codex">;

export function isRunnerProvider(value: unknown): value is RunnerProvider {
  return (
    value === "claude" ||
    value === "opencode" ||
    value === "opencode-sdk" ||
    value === "codex-app-server" ||
    value === "codex"
  );
}

/**
 * Subset of RunnerProvider that the runtime can actually spawn today. `codex`
 * is in the union as a planned CLI-fallback provider but is rejected at every user-facing
 * boundary (env parse, `!provider` command) so an operator never reaches the
 * point where `spawnRunner` throws mid-turn with the cause buried in a
 * session-manager catch.
 *
 * Update this list when a new provider's spawner lands.
 */
export function isImplementedRunnerProvider(
  value: unknown,
): value is ImplementedRunnerProvider {
  return (
    value === "claude" ||
    value === "opencode" ||
    value === "opencode-sdk" ||
    value === "codex-app-server"
  );
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
  /**
   * Per-agent tmux session name. driverMode lives on the parent ThreadSession
   * (thread-level decision); only the unique tmux session name is per-agent.
   */
  tmuxSessionName?: string | null;
  /** Compare-and-set version for concurrent agent-row updates. Missing → 0. */
  stateVersion?: number;
}

export interface AgentIdentity {
  username: string;
  iconEmoji?: string;
  imageUrl?: string;
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
  agentPermissions?: import("../agents/loader.ts").AgentPermissions;
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
   * Set when a dormant thread is woken by `!listen` or an @mention. The next
   * runner turn injects recent Slack thread history even when resuming an
   * existing model session, so the agent sees messages that arrived while it
   * was intentionally staying out. Cleared after that catch-up prompt is built.
   */
  needsThreadCatchup: boolean;
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
  /**
   * Explicit Claude-runner model override, sourced from the active agent's
   * `model.claude` frontmatter. Wins over the GPT→Claude fallback map in
   * `resolveClaudeModel`. Null when the agent declares no Claude override.
   */
  modelClaude?: string | null;
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
  /**
   * Which top-level agent owns the thread's tmux session — "lead" for support
   * channels, "default" elsewhere. Persisted alongside `tmuxSessionName` so
   * reconciliation/eviction can address the right (threadId, agentName) key
   * without guessing. Null until the first tmux turn.
   */
  topLevelTmuxAgent: string | null;
  /** Number of times this session's current turn has been idle-interrupted and resumed. */
  idleInterruptCount: number;
  /** Number of automatic lead-pipeline guard continuations attempted for the current turn. */
  pipelineGuardRetryCount?: number;
  /**
   * Compare-and-set version for concurrent thread-session updates. Incremented
   * on every successful store write. Missing / legacy rows normalize to 0.
   */
  stateVersion?: number;
}

export function createSession(
  threadId: string,
  channel: string,
  defaultVerbosity: SessionVerbosity = "normal",
  providerOrDriver: RunnerProvider | DriverMode = "claude",
  driverMode: DriverMode = "headless",
): ThreadSession {
  const provider = isRunnerProvider(providerOrDriver)
    ? providerOrDriver
    : "claude";
  const resolvedDriverMode = isDriverMode(providerOrDriver)
    ? providerOrDriver
    : driverMode;

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
    dormant: false,
    needsThreadCatchup: false,
    dormantAnnounced: false,
    humanParticipants: [],
    model: null,
    cwd: null,
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    driverMode: resolvedDriverMode,
    tmuxSessionName: null,
    topLevelTmuxAgent: null,
    idleInterruptCount: 0,
    pipelineGuardRetryCount: 0,
    stateVersion: 0,
  };
}

function isDriverMode(value: unknown): value is DriverMode {
  return value === "headless" || value === "tmux";
}
