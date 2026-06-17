/**
 * Pending-approval registry for Slack-mediated permission round-trips.
 *
 * When a human-gated Claude turn hits a tool that needs approval, Claude calls
 * the `request_permission` MCP tool (via `--permission-prompt-tool`). That tool
 * posts an Allow/Deny prompt to the Slack thread and must BLOCK until a human
 * clicks a button. The MCP server and the Bolt `app.action` click handler run
 * in the SAME process, so this in-memory registry is the wakeup bridge: the
 * tool awaits a promise keyed by a token; the click handler resolves it.
 *
 * No SQLite here — durable button records live in SlackActionStore. This
 * registry is purely the in-process resolver + default-deny timeout.
 */

export type ApprovalDecision = "allow" | "deny";

export interface PendingApproval {
  token: string;
  resolve: (decision: ApprovalDecision) => void;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 240_000;

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/**
 * Read the approval timeout from env lazily (not cached at import) so tests can
 * override `CLAUDE_APPROVAL_TIMEOUT_MS` before calling. Default 240000ms —
 * deliberately under Junior's 5-min idle/turn timeout so the wait resolves
 * cleanly (default-deny) before the turn is killed.
 *
 * INVARIANT: this must stay below `config.session.idleTimeoutMs` (default
 * 300000). The `request_permission` tool_use event resets the idle timer right
 * before the block, giving the human `approvalTimeoutMs` to respond; if
 * `SESSION_IDLE_TIMEOUT_MS` is ever set at/below `CLAUDE_APPROVAL_TIMEOUT_MS`,
 * the turn gets SIGINT'd mid-approval. Keep the approval timeout the smaller.
 */
export function approvalTimeoutMs(): number {
  const raw = Number(process.env.CLAUDE_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPROVAL_TIMEOUT_MS;
}

/**
 * Register a pending approval and return a promise that resolves when a human
 * responds via {@link resolvePendingApproval} or default-denies after
 * `timeoutMs` (defaults to {@link approvalTimeoutMs}).
 */
export function registerPendingApproval(
  token: string,
  timeoutMs: number = approvalTimeoutMs(),
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      // Default-deny on timeout, then clean up.
      const entry = pending.get(token);
      if (entry) {
        pending.delete(token);
        entry.resolve("deny");
      }
    }, timeoutMs);
    timer.unref?.();
    pending.set(token, { resolve, timer });
  });
}

/**
 * Resolve a pending approval with a human decision. Idempotent: returns true
 * the first time the token is found, false for unknown/already-resolved tokens.
 */
export function resolvePendingApproval(
  token: string,
  decision: ApprovalDecision,
): boolean {
  const entry = pending.get(token);
  if (!entry) return false;
  pending.delete(token);
  clearTimeout(entry.timer);
  entry.resolve(decision);
  return true;
}
