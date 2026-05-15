# Thread Context & Claude Instance Awareness

## Problem

When Junior spawns a `claude -p` process, that process has zero knowledge of the Slack conversation it's responding to. It doesn't know its own name, can't see prior messages, can't see images users shared, and has no way to send files back. `--resume` carries Claude's own history forward, but not the Slack thread's.

**Painful part:** Without context, Claude hallucinates thread history, doesn't recognize other bots' messages, and gives generic responses.
**"Finally" moment:** Claude knows who it is, sees the thread (including images), knows which agents it may dispatch, and can post or upload back to Slack.

## What It Builds

`buildPromptPreamble()` assembles a first-turn preamble. Each block is gated by the resolved agent's `AgentContextProfile` (frontmatter `context.*` flags; defaults all-true).

1. **`<identity>`** — Junior's persona (see [agent-definitions](agent-definitions.md)) + the bot's Slack user ID so Claude can recognize its own messages.
2. **`<slack-context>`** — channel name + ID, thread_ts, instruction not to search Slack, how to tag users via `<@USERID>`, the `NO_SLACK_MESSAGE` sentinel, and the no-double-post rule when `slack_send_message` was used.
3. **`<workspace>`** — see Workspace Block below.
4. **`<thread-context>`** — prior messages from `conversations.replies` (limit 100, excluding the current message), labeled `User(Name <@U…>)` or `Junior (you)`, with `[shared image: name]` annotations.
5. **`<persistent-agent-state>`** — injected by the manager (not preamble itself) when the agent has `context.agentState`; lists per-thread agent sessions and pending counts.
6. **`<dispatch-allow>`** — appended to the system prompt by the manager (`buildDispatchAllowBlock`) so every agent sees the authoritative list of `!<agent>` directives it may emit. See [agent-routing](agent-routing.md).

On **resumed turns** (sessionId already set), `--resume` carries identity/slack/history forward. The manager skips the full preamble and re-emits only the workspace block (cheap insurance for the worktree safety rule), when the agent declares `context.workspace`.

## Workspace Block

`buildWorkspaceBlock()` renders one of two shapes:

- **Multi-repo** (bug-pipeline threads with `session.worktreePaths`) — lists each repo's worktree path, bare-repo path (off-limits), branch (`slack/<threadId>`), and base (`origin/main` or `repo.defaultBase`). See [bug-pipeline-worktrees](bug-pipeline-worktrees.md).
- **Single-repo** (`!repo` flow) — worktree path, repo path, branch, original bare-repo path.

Both formats interpolate concrete paths into the rules so Claude can't hallucinate substitutes. Rules forbid writing/editing/`cd`-ing outside the worktree and require PRs (single-repo) / `!devserver` instead of running dev servers (multi-repo).

Worktree creation is unconditional for target-repo threads — the manager creates one before building the workspace block so Claude never edits the shared origin repo.

## Mention Resolution

`resolveSlackMentions()` rewrites `<@U123>` tokens to `@DisplayName (<@U123>)` so Claude can read names AND tag back. It pre-resolves unique IDs in parallel and replaces in a single regex pass — repeated mentions of the same user no longer corrupt each other.

Applied to:
- Thread history (each message's `text`)
- The incoming user prompt (`readablePrompt`)

User and channel names are cached in module-level Maps.

## File Handling

- **Images on the message** — downloaded to `/tmp/junior-files/<threadId>/` via `files.ts`, then appended to the prompt as Read-tool paths. Image MIME only (png/jpeg/gif/webp).
- **Historical images** — surfaced as `[shared image: name.png]` annotations in `<thread-context>` (no download).
- **Outbound files** — the spawner exports `SLACK_CHANNEL`, `SLACK_THREAD_TS`, `SLACK_BOT_TOKEN`; `bin/slack-upload.sh` and Playwright MCP screenshots use them with zero per-thread config.

## Key Files

| File | Purpose |
|---|---|
| `src/slack/thread-context.ts` | Preamble assembly, workspace block, mention resolution |
| `src/persona.ts` | Loads identity files (cached) |
| `src/agents/loader.ts` | `AgentContextProfile` + `DEFAULT_CONTEXT_PROFILE` |
| `src/agents/router.ts` | Agent resolution with target-repo → org overlay → fallback search order |
| `src/support/agents.ts` | `buildDispatchAllowBlock` (injected per agent) |
| `src/slack/files.ts` | Image download |
| `src/session/manager.ts` | Calls preamble on first turn, workspace-only on resume, appends agent-state + dispatch-allow |
| `src/claude/spawner.ts` | Exports Slack env vars |
| `bin/slack-upload.sh` | Outbound uploads via env vars |

## Cross-References

- Persona / agent .md files / overlay search path: [agent-definitions](agent-definitions.md), [agent-routing](agent-routing.md)
- Worktree creation policy and paths: [worktree-manager](worktree-manager.md), [bug-pipeline-worktrees](bug-pipeline-worktrees.md)
- Per-agent sessions surfaced in `<persistent-agent-state>`: [persistent-agents](persistent-agents.md)
- Outbound posts and the `NO_SLACK_MESSAGE` sentinel: [stream-to-slack](stream-to-slack.md), [mcp-server](mcp-server.md)
