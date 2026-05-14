# Code Index: Thread Context

Builds the prompt preamble that gives spawned Claude processes identity, channel awareness, workspace safety rules, and conversation history.

## Code Index

### src/slack/thread-context.ts

| Symbol | Purpose |
|---|---|
| `buildPromptPreamble(app, channel, threadTs, latestTs, botUserId?, workspace?, worktreePaths?, repos?, contextProfile?)` | Composes the full preamble. Each block (`identity`, `slack-context`, `workspace`, `thread-context`) emitted only if its flag in `contextProfile` is true. Defaults to all-true via `DEFAULT_CONTEXT_PROFILE`. |
| `buildWorkspaceBlock(workspace, worktreePaths?, repos?, threadId?)` | Standalone workspace-rules block. Used in the full preamble AND on resumed turns (cheap safety reminder). Multi-repo format when `worktreePaths` non-empty, single-repo format otherwise. |
| `resolveSlackMentions(app, text)` | Rewrites `<@U…>` → `@DisplayName (<@U…>)` so agents can address users by name. Pre-resolves unique IDs in parallel, then single-pass regex replace. |
| `WorkspaceContext` | Type: `{ worktreePath, repoName, repoPath, branchName }` |

### Caches (module-private)

| Cache | Keyed | Filled by |
|---|---|---|
| `channelNameCache` | channel ID → name | `resolveChannelName` (`conversations.info`) |
| `userNameCache` | user ID → display name | `resolveUserName` (`users.info`); picks `profile.display_name → real_name → name → id`) |

Both caches live for the process lifetime — no TTL. Tradeoff: renames/relabels need a restart to refresh.

## Preamble Structure

```xml
<identity>
{persona from IDENTITY.md + SOUL.md}
Your Slack user ID is {botUserId}. Messages from this user ID in the thread are yours.
</identity>

<slack-context>
Channel: #{name} ({channelId})
Thread: {ts}
... (NO_SLACK_MESSAGE sentinel rules, no-double-post rule)
</slack-context>

<workspace>
(single-repo: Target repo / Worktree / branch / RULES)
(multi-repo:  per-repo blocks of worktree + bare-repo + branch + base)
</workspace>

<thread-context>
Junior (you): previous response
User(Name <@U123>): their message [shared image: screenshot.png]
</thread-context>
```

## Key Concepts

### Context-profile gating

`buildPromptPreamble` only fetches data for enabled blocks — skipping `threadHistory` means no `conversations.replies` round-trip. Saves tokens AND latency for lightweight task agents.

### Workspace block on resumed turns

`runClaudeWithAgent` injects the full preamble on first turn (when there's no `sessionId` yet) and only the workspace block on resumed turns. The workspace safety rule ("don't edit the bare repo") is cheap insurance that's worth re-asserting every turn.

### Multi-repo workspace format

Bug-pipeline threads have `worktreePaths: Record<repoName, path>`. The multi-repo block lists each repo's worktree, bare repo (off-limits), branch (`slack/<threadId>`), and base ref, plus a numbered RULES list that forbids editing outside the worktrees and running dev servers directly (`!devserver` is the supported path).

### Thread history

Excludes the current message (`latestTs`), max 100 replies. Bot messages labeled `"Junior (you)"`; users labeled `User(DisplayName <@USERID>)`. File names appended as `[shared image: foo.png]`. Mentions in body text resolved via `resolveSlackMentions`.

## Dependencies

- **Uses**: `@slack/bolt` (`conversations.replies`, `conversations.info`, `users.info`), `persona.loadPersona`, `agents/loader` (`AgentContextProfile`, `DEFAULT_CONTEXT_PROFILE`), `slack/formatting` (`NO_SLACK_MESSAGE`)
- **Used by**: `SessionManager.runClaudeWithAgent` (first-turn preamble + per-turn workspace block + mention resolution on prompts)
