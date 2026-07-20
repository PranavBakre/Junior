# Agent Action Buttons

Status: **implemented in progress**.

Persistent agents can attach safe Slack action buttons to final responses. The first consumer is the review agent: `Re-review`, `Make fix`, and `Cleanup worktree`.

## Contract

Agents append a stripped sentinel block to the final response:

```text
<junior-actions>
[
  {
    "id": "review:rereview",
    "label": "Re-review",
    "style": "primary",
    "type": "dispatch_agent",
    "agent": "review",
    "prompt": "Re-review the latest PR/head. Read thread history first."
  },
  {
    "id": "review:make-fix",
    "label": "Make fix",
    "style": "danger",
    "type": "dispatch_agent",
    "agent": "thinker",
    "prompt": "Address the blockers from the latest review. Read thread history first."
  },
  {
    "id": "thread:cleanup-worktree",
    "label": "Cleanup worktree",
    "type": "cleanup_worktree"
  }
]
</junior-actions>
```

Junior validates the JSON, strips it from the Slack-visible text, renders Slack Block Kit buttons, and stores opaque button tokens in SQLite. Slack payloads carry only the token, never prompts, paths, or executable commands.

## Decisions

- Action records are stored in SQLite.
- Buttons expire when the same source agent receives a new message or posts a newer response in the same thread.
- Clicked buttons are disabled by updating the original Slack message and removing the actions block.
- `Make fix` dispatches `thinker`; thinker reads Slack thread history instead of relying on copied review text.
- `cleanup_worktree` may be clicked by any thread participant.
- Worktree cleanup refuses tracked changes and unknown untracked files.
- Cleanup may proceed when the only untracked paths are `learnings.md`, `.codex/`, `.claude/`, or `.DS_Store`.
- `review: approved` does **not** automatically clean up worktrees. Cleanup is explicit via the Cleanup worktree button (or a later terminal-pipeline transition). Merge/retry buttons stay available after approval.
- Mutating PR actions (`review:merge-gxt-admin`) require a complete structured `resourceAnchor` (`repo`, `prNumber`, `headSha`, `expectedBase`). Generic merge buttons without an exact anchor are not rendered.

## Action Types

### `dispatch_agent`

Dispatches a persistent agent in the same Slack thread without posting a public `!<agent>` directive.

Validation:

- The target agent must be registered.
- The thread session must still exist and not be muted.
- Duplicate clicks are blocked by claiming the SQLite token before execution.

### `cleanup_worktree`

Removes only worktrees registered on the session (`worktreePath` / `worktreePaths`).

Validation:

- The session must be idle.
- No persistent agent in the thread may be busy.
- Tracked changes refuse cleanup.
- Unknown untracked files refuse cleanup.

## Storage

`slack_action_buttons` stores token, channel/thread/message ids, message text, source agent, action JSON, status, click metadata, and a long defensive expiry timestamp. The wall-clock timestamp is storage hygiene; user-facing expiry is same-agent invalidation.

## Slack UX

Final responses with actions post as:

- section block: original response text
- actions block: up to five buttons
- fallback text: original response text

Streaming status messages never carry buttons.
