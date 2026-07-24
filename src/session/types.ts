export interface PendingMessage {
  user: string;
  text: string;
  /** Raw conversational text when `text` contains a control-plane envelope. */
  policyText?: string;
  ts: string;
  command?: string;
  hasFiles?: boolean;
  isInternal?: boolean;
  dedupeKey?: string;
  pipelineInvocation?: PipelineInvocationRef;
}

/** Trusted control-plane identity attached by the outbox pump, never by a model. */
export interface PipelineInvocationRef {
  runId: string;
  assignmentId: string;
  dispatchKey: string;
  outcomeCountAtDispatch: number;
  retryCount: number;
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
  /** Working directory in which the native provider session was created. */
  sessionCwd?: string | null;
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
  activePipelineInvocation?: PipelineInvocationRef | null;
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
  /** Working directory in which sessionId / leadSessionId was created. */
  sessionCwd?: string | null;
  agentSessions: Record<string, AgentSession>;
  worktreePath: string | null;
  /** Per-repo worktree paths for bug-pipeline threads. Keys are repo names (from RepoConfig.name). */
  worktreePaths: Record<string, string>;
  /**
   * Ephemeral package manager detected from the active review worktree.
   * Set only on the run-session copy; never treated as durable repo metadata.
   */
  verificationPackageManager?: import("../worktree/package-manager.ts").JavaScriptPackageManager | null;
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
  /**
   * Slack user IDs of humans who have directly engaged Junior in this
   * thread: their message @mentioned it, routed to a runner turn, or they
   * summoned it with `!listen`. Subset of `humanParticipants` — `!aside`
   * posters and the sender whose sidebar message fired the auto-dormant
   * trigger are participants but not engaged. The attention gate only
   * auto-dormants on a message from a non-engaged human: once someone is
   * talking to Junior directly, their plain follow-ups are conversation,
   * not a sidebar.
   */
  engagedHumans: string[];
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
  /** Slack user ID of the human who started the current busy turn. Cleared on settle. */
  activeTurnAuthor?: string | null;
  /** Whether the active turn has already been interrupt-consolidated. */
  activeTurnWasInterrupted?: boolean;
  /** Original input for the owned top-level turn, retained for safe replay. */
  activeTurnInput?: PendingMessage | null;
  /** Wall-clock start of the owned top-level turn. */
  activeTurnStartedAt?: number | null;
  /** Durable ownership generation for the active top-level turn. */
  activeTurnGeneration?: string | null;
  /** Generation whose response must be suppressed and replayed as a burst. */
  supersededTurnGeneration?: string | null;
  /** Completion won the publication race; later follow-ups must buffer. */
  activeTurnCompletionClaimed?: boolean;
  /** Number of automatic lead-pipeline guard continuations attempted for the current turn. */
  pipelineGuardRetryCount?: number;
  /**
   * Compare-and-set version for concurrent thread-session updates. Incremented
   * on every successful store write. Missing / legacy rows normalize to 0.
   */
  stateVersion?: number;
  /**
   * Active multi-agent pipeline run (ProductRun / BugRun). Null when the
   * thread is not under the durable pipeline control plane. Phase 2 substrate
   * only — live routing still does not create pipeline rows when mode=off.
   */
  activePipelineRunId?: string | null;
  activePipelineKind?: "product" | "bug" | null;
  /** Universal durable run backing the current task, including kind=default. */
  activeRunId?: string | null;
  /** Exact assignment dispatch currently owned by the top-level runner. */
  activePipelineInvocation?: PipelineInvocationRef | null;
  /** Authoritative Slack source turn for the active top-level invocation. */
  activeTopLevelMessageTs?: string | null;
  /**
   * Ephemeral Slack event identity for the current runner invocation. It is
   * copied onto the run-only session passed to providers and must not be
   * persisted. MCP pipeline starts use it as an authenticated idempotency
   * source instead of trusting a model-supplied timestamp.
   */
  currentMessageTs?: string | null;
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
    sessionCwd: null,
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
    engagedHumans: [],
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
    activeTurnAuthor: null,
    activeTurnWasInterrupted: false,
    activeTurnInput: null,
    activeTurnStartedAt: null,
    activeTurnGeneration: null,
    supersededTurnGeneration: null,
    activeTurnCompletionClaimed: false,
    pipelineGuardRetryCount: 0,
    stateVersion: 0,
    activePipelineRunId: null,
    activePipelineKind: null,
    activeRunId: null,
  };
}

function isDriverMode(value: unknown): value is DriverMode {
  return value === "headless" || value === "tmux";
}
