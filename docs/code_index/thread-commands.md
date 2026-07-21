# Code Index: Thread Commands

`!command` parsing and dispatch in `SessionManager.handleCommand`. `!<persistent-agent>` directives (e.g. `!review`, `!reproducer`) are NOT commands — they're handled by `AgentDispatcher` (see `persistent-agents.md`).

## Code Index

| Symbol | File | Purpose |
|---|---|---|
| `KNOWN_COMMANDS` | `slack/commands.ts` | `build, frontend, architect, pm, cancel, clear, reset, status, repo, branch, agent, provider, quiet, verbose, normal, help, workflow, workflows, adhoc, bugs, mute, unmute, stop, driver, aside, listen` |
| `parseCommand(text)` | `slack/commands.ts` | Splits `!build fix auth` → `{ command: "build", text: "fix auth" }`. Returns `{ command: null, text }` for unknown or non-`!` input. |
| `SessionManager.handleCommand(session, event)` | `session/manager.ts` | Dispatches by `event.command`; runner-selection commands (`build`, `frontend`, `architect`, `pm`) fall through to a run, while control commands are consumed |
| `SessionManager.gateAttention(event)` | `session/manager.ts` | Runs before any routing in `index.ts`. Consumes `!aside` and `!listen`, drops everything while `session.dormant`, and fires the one-shot auto-dormant trigger when a second human posts without `@`-mentioning Junior. Returns `true` when the message is consumed. Auto-trigger channels (`channelDefaults[channel]`) are exempt. |

## Supported Commands

| Command | Effect | Falls through to Claude? |
|---|---|---|
| `!build <text>` | Sets `agentType = "build"` | Yes |
| `!frontend <text>` | Sets `agentType = "frontend"` | Yes |
| `!architect <text>` | Sets `agentType = "architect"` | Yes |
| `!pm <text>` | Sets `agentType = "pm"` | Yes |
| `!repo <name>` | Sets `targetRepo` (validates against `config.repos`) | No |
| `!branch <ref>` | Sets `baseRef` for next worktree creation | No |
| `!agent <junior\|lead>` | Sets thread-level `defaultAgent` override (used by `AgentDispatcher`) | No |
| `!cancel` | Kills all handles for the thread, clears pending, marks idle | No |
| `!reset <agent\|all>` | **Admin-gated**. `all` → `resetSession`. `<agent>` → `resetAgent` (`lead`/`default` clear top-level; others clear `agentSessions[name]`) | No |
| `!clear` | **Admin-gated**. Archives full thread to `data/thread-archives/`, deletes Junior bot messages only, clears status-pill cache | No |
| `!status` | Posts thread/agent/repo/worktree/pending/last-activity summary | No |
| `!quiet` / `!normal` / `!verbose` | Sets `session.verbosity` | No |
| `!provider <name>` | Sets the thread runner provider | No |
| `!stop` | Stops the active runner/driver | No |
| `!driver <headless\|tmux>` | Sets Claude's driver mode | No |
| `!workflow ...` / `!workflows` | Lists or controls dynamic workflows | No |
| `!help` | Posts command reference | No |
| `!adhoc <text>` / `!bugs <text>` | Calendar item via haiku model + `cwd = /tmp/junior-utility`; accepts `today\|tomorrow` prefix; reshapes `event.text` into a structured GCal task | Yes |
| `!mute` / `!unmute` | **Admin-gated**. Toggles `session.muted`. Muted sessions discard buffered messages on drain. | No |
| `!aside [text]` | Consumed in `gateAttention`. Drops the message, reacts 👀, no state change. Anyone. | No |
| `!listen` | Consumed in `gateAttention`. Clears `session.dormant` (if set), reacts 👂. Sticky `dormantAnnounced` stays — no re-trigger. Anyone. | No |

## Admin Gating

`denyIfNotAdmin(event)` checks `isAdmin(event.user)` — env bootstrap (`ADMIN_SLACK_USER_ID`) OR membership in the `admins` SQLite table. When both tiers are empty the manager runs in "open mode" (local-dev fallback). Denied commands trigger an `x` reaction via `onReaction` and post nothing to the thread (avoids leaking the gating model).

For `!reset`: gating runs BEFORE arg parsing — a non-admin sending bare `!reset` gets the silent `x`, not a usage hint.

## Command Flow

```
"!build fix the auth bug"
  │
  ├── parseCommand() → { command: "build", text: "fix the auth bug" }
  │
  └── SessionManager.runSingleSession(event, "default")
        ├── handleCommand(session, event)
        │     └── case "build": session.agentType = "build"; return false   ← falls through
        ├── busy guard / buffer
        └── runClaudeWithAgent(session, "fix the auth bug", ts, files, "default")
              └── agentRouter resolves `build` agent → worktree → spawn Claude
```

## Dependencies

- **Uses**: `session/store` (mutations), `slack/commands`, `agents/router` (implicitly via runClaudeWithAgent)
- **Used by**: `SessionManager.runSingleSession` (command dispatch before busy check)
