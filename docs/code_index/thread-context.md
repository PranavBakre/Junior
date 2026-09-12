# Code Index: Thread Context

Builds the prompt preamble that gives spawned Claude processes identity, channel awareness, workspace safety rules, and conversation history.

## Code Index

### src/slack/thread-context.ts

| Symbol | Purpose |
|---|---|
| `buildPromptPreamble(app, channel, threadTs, latestTs, botUserId?, workspace?, worktreePaths?, repos?, contextProfile?, identityRepoName?, identityAuthenticated?)` | Composes the full preamble. Each block (`identity`, `slack-context`, `workspace`, `thread-context`) emitted only if its flag in `contextProfile` is true. Defaults to all-true via `DEFAULT_CONTEXT_PROFILE`. |
| `buildWorkspaceBlock(workspace, worktreePaths?, repos?, threadId?, identityRepoName?, identityAuthenticated?)` | Standalone workspace-rules block. Used in the full preamble AND on resumed turns (cheap safety reminder). Multi-repo format when `worktreePaths` non-empty; single-repo when a workspace exists; a `<github-identity>` block when neither does but a repo is bound for authentication; `null` otherwise. |
| `<github-identity>` block | Names the repo a turn authenticates against, so a turn holding `GH_TOKEN` without a checkout knows what to use it against. Emitted under the `workspace` flag. The caller passes `identityRepoName` whenever an identity resolved — including when credentials did *not* arrive, because the block then says so (`identityAuthenticated: false`) instead of silently withholding. A resolved-but-unauthenticated identity is rendered rather than hidden: an agent that is told the cause reports it, while one that is told nothing invents a permissions story. That holds in the worktree-failure case too: withholding the token does not withhold the repo name, because the "act on the repository directly" invitation is gated on `identityAuthenticated` — which is false exactly when the failed repo is the identity repo, the case where no credentials were resolved. When an identity resolved but credentials did not arrive, the same "credentials could not be resolved" sentence is added to the `<workspace>` block in **both** its shapes — single-repo and multi-repo — so no turn is left to invent a permissions story. |
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

<github-identity>
(alternative to <workspace>, not nested in it: named repo + what Junior
resolved for this turn, no write rules)
</github-identity>

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

The workspace block also states that Junior refreshed remote refs before the
turn. Sandboxed workers inspect the configured `origin/*` base and do not run
`git fetch`, because linked worktrees keep fetch metadata in the off-limits
shared checkout.

### Multi-repo workspace format

Bug-pipeline threads have `worktreePaths: Record<repoName, path>`. The multi-repo block lists each repo's worktree, bare repo (off-limits), branch (`slack/<threadId>`), and base ref, plus a numbered RULES list that forbids editing outside the worktrees and running dev servers directly (`!devserver` is the supported path).

### Thread history

Excludes the current message (`latestTs`), max 100 replies. Bot messages labeled `"Junior (you)"`; users labeled `User(DisplayName <@USERID>)`. File names appended as `[shared image: foo.png]`. Mentions in body text resolved via `resolveSlackMentions`.

## Dependencies

- **Uses**: `@slack/bolt` (`conversations.replies`, `conversations.info`, `users.info`), `persona.loadPersona`, `agents/loader` (`AgentContextProfile`, `DEFAULT_CONTEXT_PROFILE`), `slack/formatting` (`NO_SLACK_MESSAGE`)
- **Used by**: `SessionManager.runClaudeWithAgent` (first-turn preamble + per-turn workspace block + mention resolution on prompts)
