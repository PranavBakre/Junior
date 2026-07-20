# Agent Action Buttons

Status: **proposal, decisions captured**.

Captures the 2026-06-09 Slack UX request: most replies to the review agent are mechanical follow-ups like `!review re-review`; review messages should expose one-click actions such as re-review, make the fix, and cleanup the thread worktree.

## Problem

Persistent agents already post useful final messages in Slack, but follow-up actions still require a human to know and type the right directive.

Example from a review thread:

1. User asks Junior to review a PR.
2. `review` posts `changes-requested`.
3. Human fixes the PR and replies `!review re-review`.
4. `review` runs again and approves.

That manual `!review re-review` is predictable enough to become a button. The same is true for common next actions after a review verdict:

- `Re-review` after a human pushes fixes.
- `Make fix` after `review` reports blockers.
- `Cleanup worktree` after the thread is done.

The goal is not to hardcode review-only buttons. The goal is a small, safe, reusable action-button contract that agents can opt into when they post a final message.

## Full Vision

Agents can attach a small set of quick actions to their final Slack message. Junior renders those actions as Slack Block Kit buttons and handles clicks server-side.

Actions are allow-listed operations, not arbitrary commands. A button click should be equivalent to a safe, explicit Junior operation the human could already request in the thread.

Initial action types:

| Action type | Purpose |
|---|---|
| `dispatch_agent` | Dispatch a persistent agent in the same thread with a fixed prompt. |
| `cleanup_worktree` | Cleanup registered worktree state for the current thread. |

Initial review buttons:

| Button | Action |
|---|---|
| `Re-review` | `dispatch_agent` to `review` with prompt `re-review the latest PR/head using the prior review context`. |
| `Make fix` | `dispatch_agent` to `thinker` with the review verdict and request to address blockers. |
| `Cleanup worktree` | `cleanup_worktree` for the thread's registered repo worktree(s). |

## Non-goals

- No arbitrary shell commands from Slack button payloads.
- No agent-defined raw Slack Block Kit JSON.
- No button execution outside the originating thread.
- No user-specific OAuth actions. Buttons run as Junior, with Junior's existing server-side validation.
- No broad workflow engine replacement. This is for small immediate thread actions.

## Agent Contract

Agents request buttons by appending an action spec to the final response. Junior strips the spec from the Slack-visible text and renders the buttons.

Proposed sentinel block:

```text
Here is the review result...

<junior-actions>
[
  {
    "id": "review:rereview",
    "label": "Re-review",
    "style": "primary",
    "type": "dispatch_agent",
    "agent": "review",
    "prompt": "re-review the latest PR/head using the prior review context"
  },
  {
    "id": "review:make-fix",
    "label": "Make fix",
    "style": "danger",
    "type": "dispatch_agent",
    "agent": "thinker",
    "prompt": "address the blockers from the latest review message"
  },
  {
    "id": "thread:cleanup-worktree",
    "label": "Cleanup worktree",
    "type": "cleanup_worktree"
  }
]
</junior-actions>
```

Rules:

- Maximum 5 actions per message.
- `label` is plain text, max 30 characters.
- `style` may be `primary`, `danger`, or omitted.
- `id` is a stable, namespaced string for logs and metrics.
- Unknown action types are ignored and logged.
- Invalid action specs are stripped from Slack output and logged; they do not fail the whole response.

The sentinel format keeps agents model-agnostic and avoids giving them direct control over Slack Block Kit structure.

## Server-side Model

Junior stores all executable action details server-side before posting the Slack message. The Slack button payload should contain only an opaque action token.

Action records are persisted in SQLite, not memory. Buttons can be clicked minutes or hours after a message is posted, and Junior restarts should not turn visible buttons into dead UI.

Suggested flow:

1. Agent final response reaches `sessionManager.onResponse`.
2. `prepareSlackResponse` or a sibling parser extracts `<junior-actions>`.
3. `SlackResponder.postResponse` posts text plus Block Kit buttons.
4. Junior stores action records in SQLite keyed by `{channel, messageTs, actionId/token}`.
5. Slack `app.action(...)` handler receives the click, acks immediately, loads the action record, revalidates session state, and executes.

Button payload should not include prompts, repo paths, shell commands, or trusted authorization data. It can include a short token only.

Suggested table:

```sql
CREATE TABLE slack_action_buttons (
  token TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_json TEXT NOT NULL,
  source_agent TEXT,
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  clicked_at INTEGER,
  clicked_by_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'clicked', 'expired', 'disabled', 'failed'))
);
```

`action_json` stores the validated server-side action payload. The Slack payload carries only `token`.

## Expiry And Disabled State

Buttons should expire. Expiry prevents stale PR/worktree actions after the underlying branch, review state, or thread state has moved on.

Policy:

- Primary expiry rule: buttons remain active only until the next action/message by the same source agent in the same thread. For example, when `review` posts another message or receives a new dispatch in that thread, older `review` buttons are disabled.
- A long absolute TTL can still exist as a defensive cleanup sweep for abandoned records, but UX correctness comes from same-agent invalidation, not the wall clock.
- Worktree cleanup buttons expire when cleanup succeeds or the session loses its registered worktree paths.
- A periodic sweep marks old active records as `expired` only as storage hygiene.

Click handling:

1. Ack the Slack action immediately.
2. Load the SQLite record by token.
3. If expired/disabled/clicked, post or ephemeral-reply a short "this action is no longer available" response.
4. If executable, mark it `clicked` or `disabled` in SQLite before executing to prevent duplicate clicks.
5. Update the original Slack message with disabled buttons or a compact "(action used)" state.

Slack does not provide a true per-button disabled mutation without replacing the message blocks, so disabling means calling `chat.update` with the same response text and either:

- remove the actions block entirely after a terminal action, or
- replace clicked buttons with plain-text context such as `Re-review started by <@U...>`.

For iteration 1, use the simpler rule: after any button click, update the original message and remove the actions block. New agent output can post fresh buttons.

## Action Execution

### `dispatch_agent`

Dispatch a persistent agent without posting a public `!<agent>` directive.

Validation:

- Session for `thread_ts` must still exist.
- Target agent must be registered.
- Source agent must be allowed to offer that dispatch. For example, `review` should not gain broad worker-dispatch powers accidentally.
- Thread must not be muted.
- If the target agent is busy, reuse the existing buffering/serialization behavior.

Execution:

- Call `SessionManager.handleAgentMessage(...)` with a synthetic Slack event.
- Set `threadId` to the original thread.
- Set `channel` to the original channel.
- Set `user` to the Slack user who clicked, or a synthetic internal user plus `triggerUser` metadata.
- Set a dedupe key derived from the Slack action token.

For `Make fix`, the first implementation should dispatch `thinker`, not `review`. Review remains a reviewer. Thinker owns code changes.

`Make fix` should not embed the review text directly in the button prompt. The prompt should tell thinker to read the thread history and latest review verdict. That keeps the button payload small and avoids stale or partial context.

### `cleanup_worktree`

Clean up worktrees registered for the thread.

Validation:

- Session must be idle or done; do not cleanup while any agent is busy.
- Dev-server queue must not hold a lock for the same repo/thread.
- Only cleanup paths that are registered in the session (`worktreePath` or `worktreePaths`), never paths supplied by the button.
- Any thread participant may click cleanup.
- If there are uncommitted tracked changes, refuse and post a short warning.
- If the only untracked files are `learnings.md`, `.codex/`, `.claude/`, or `.DS_Store`, cleanup may proceed and remove the worktree.
- If there are any other untracked files, refuse and post the paths.

Execution:

- Use `WorktreeManager` or a dedicated cleanup service.
- Remove per-thread worktree(s).
- Clear the session's worktree fields or mark them cleaned.
- Post a short thread reply with success/failure.

### Auto-cleanup after approval

Once a PR is approved, Junior should cleanup the thread worktree automatically when it is safe.

Trigger:

- A final `review` response with an approved verdict.

Validation:

- Session is idle after the review response is posted.
- Registered worktree(s) are clean or contain only expected generated/session files.
- No dev-server queue lock is held for the thread.
- The approval corresponds to the latest PR/head the review agent inspected.

Execution:

- Run the same cleanup path as the `cleanup_worktree` button.
- Post a short success/failure reply in the thread.
- Disable any cleanup buttons on the approved review message after cleanup succeeds.

If cleanup is unsafe, do not force it. Post a short refusal with the dirty paths or busy state.

## Slack Rendering

Post final responses as normal Slack messages with blocks when actions exist:

- Section block containing the final text.
- Actions block containing buttons.
- Fallback `text` remains the plain response for notifications and clients that do not render blocks.

Only final responses get action buttons. Streaming status messages should stay plain/editable and should not carry buttons.

## Security And Safety

Button clicks are external actions because they mutate Slack-visible state and may dispatch agents that edit code. Treat them like a typed Slack command:

- Ack fast, execute async if needed.
- Log the clicking user, channel, thread, action id, target agent, and result.
- Revalidate everything on click. Never trust payload state from Slack.
- Keep the action registry allow-listed.
- Do not let agents define shell commands, file paths, repo names for cleanup, or raw Block Kit.
- Prefer refusal with a thread reply over best-effort cleanup when state is ambiguous.

## First Iteration

Implement the narrow path that proves the pattern:

1. Parser for `<junior-actions>` with tests.
2. `SlackResponder.postResponse` support for optional actions.
3. SQLite-backed action button store.
4. `registerAgentActionButtons(app, store, sessionManager, worktreeManager)` wired from `src/index.ts`.
5. `dispatch_agent` handler for `review` and `thinker`.
6. `cleanup_worktree` handler that refuses dirty/busy worktrees.
7. Button expiry and message update that removes actions after a click.
8. Auto-cleanup after approved review verdicts.
9. Update `agents-org/review.md` to emit the three review actions on final review verdicts.

Acceptance tests:

- A review `changes-requested` message renders `Re-review`, `Make fix`, and `Cleanup worktree`.
- Clicking `Re-review` dispatches `review` in the same thread without posting a public `!review` message.
- Clicking `Make fix` dispatches `thinker` with the latest review context.
- Clicking `Cleanup worktree` refuses while an agent is busy.
- Clicking `Cleanup worktree` removes only registered clean worktrees when idle.
- Approved review verdicts automatically cleanup safe registered worktrees.
- Clicked buttons are disabled or removed from the original Slack message.
- Expired buttons do not execute.
- Malformed action specs are stripped from Slack-visible text and do not break response posting.

## Decisions

- Action records are stored in SQLite.
- Buttons expire on the next action/message by the same source agent in the same thread. A long absolute TTL may exist only as a defensive storage cleanup.
- Once a PR is approved, Junior attempts automatic worktree cleanup using the same safe cleanup path as the button.
- `Make fix` dispatches thinker with an instruction to read thread history, not an embedded copy of the review message.
- Buttons are disabled/removed after click by updating the original Slack message.
- Any thread participant may click `cleanup_worktree`.
- Worktree cleanup refuses tracked changes and unknown untracked files. It may proceed when the only untracked paths are `learnings.md`, `.codex/`, `.claude/`, or `.DS_Store`.

## Cut List

- Raw custom Block Kit layouts.
- Modal forms for action parameters.
- Force cleanup of dirty worktrees.
- GitHub merge/deploy buttons.
- Cross-thread or cross-channel action dispatch.
- Per-user action visibility.
