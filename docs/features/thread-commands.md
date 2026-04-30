# Thread Commands

## Problem

Users need to control thread behavior beyond just sending messages. Reset a broken session, check what's running, switch agent types, change the target repo or branch. These are control-plane operations that don't need Claude — the bot handles them directly.

**Who has this problem:** Users managing active Slack threads.
**What happens today:** Nothing — no way to control sessions.
**Painful part:** Namespace collision. `!build fix auth` is a command + prompt. `!reset` is a pure command. `!status` might be a Slack-native command. Need clean parsing that doesn't conflict with Slack's built-in slash commands.
**"Finally" moment:** `!status` → "Session active. Agent: build. Worktree: slack/1234. Last activity: 2 min ago." `!reset` → "Session cleared." Everything feels controllable.

## Full Vision

- `!reset` — Clear session (kill process if running, remove session state, optionally remove worktree)
- `!status` — Show session state (agent type, worktree, busy/idle, last activity, pending messages count)
- `!build [prompt]` — Set agent to build, create worktree if needed, run prompt
- `!frontend [prompt]` — Set agent to frontend, create worktree, run prompt
- `!review [prompt]` — Set agent to review (no worktree needed), run prompt
- `!architect [prompt]` — Set agent to architect, run prompt
- `!repo <name>` — Switch target repo for this thread
- `!branch <ref>` — Set worktree base ref (next worktree creation uses this)
- `!quiet` / `!normal` / `!verbose` — Set verbosity
- `!mute` — Stop seeing or replying to any messages until `!unmute`
- `!unmute` — Resume normal operation
- `!help` — List available commands

## Design Decision: `!` prefix, not Slack slash commands

Two options were considered and rejected:

1. **Slack slash commands** (`/junior-build`) — requires registering each command with Slack's API, adds latency, limits to predefined commands, needs a callback URL.
2. **`/` prefix in message text** — **Slack intercepts messages starting with `/` as slash commands.** You can't type `!build fix auth` in a Slack message — Slack tries to find a registered `!build` command and errors out.

Instead, use `!` prefix:

- Message starts with `!` → extract command + remaining text
- Message doesn't start with `!` → entire message is the prompt

`!` is not intercepted by Slack, visually distinct, and commonly used for bot commands in chat platforms (Discord, IRC).

## Dependencies

- Slack Event Handler (feature: [slack-event-handler.md](slack-event-handler.md)) — passes raw text
- Session Manager (feature: [session-management.md](session-management.md)) — executes state changes
- Worktree Manager (feature: [worktree-manager.md](worktree-manager.md)) — for !branch and !repo
- Agent Router (feature: [agent-routing.md](agent-routing.md)) — for agent-switching commands

## Iterations

### Iteration 0: !reset and !status (~20 min)

The two most critical control commands.

**What it adds:**
- Parse leading `!command` from message text in event handler
- `!reset`: if process running → kill it. Clear session. Remove worktree if exists and clean. Reply "Session reset."
- `!status`: reply with session info or "No active session."
  ```
  Agent: build
  Worktree: example-backend/.claude/worktrees/slack-1234
  Status: idle
  Last activity: 2 min ago
  Pending messages: 0
  ```
- Unknown commands: treat the whole message (including `!whatever`) as a prompt

**Test:** Active session → `!status` shows info. `!reset` clears it. `!status` again → "No active session." `!unknowncmd hello` → treated as prompt.
**Defers:** All other commands.

### Iteration 1: Agent commands (!build, !review, !frontend, !architect) (~20 min)

**What it adds:**
- `!build [prompt]` → set `session.agentType = "build"`, create worktree if needed, pass prompt to session manager
- `!review [prompt]` → set `session.agentType = "review"`, no worktree, pass prompt
- `!frontend [prompt]` → set `session.agentType = "frontend"`, create worktree, pass prompt
- `!architect [prompt]` → set `session.agentType = "architect"`, no worktree, pass prompt
- If no prompt after command: reply "What should I work on?" (don't spawn Claude with empty prompt)
- Agent type persists — subsequent messages without a command use the last agent type

**Test:** `!build fix auth` → agent set to build, worktree created, Claude runs. Next message `also fix the tests` → still uses build agent. `!review check PR 4900` → switches to review, no worktree.
**Defers:** !repo, !branch, verbosity commands, !help.

### Iteration 2: !repo and !branch (~20 min)

**What it adds:**
- `!repo example-backend` or `!repo example-frontend` → set `session.targetRepo`, validate repo exists in config
- `!branch staging` → set `session.baseRef = "origin/staging"`, applies to next worktree creation
- `!branch main` → reset to default
- If worktree already exists: warn "Worktree already exists on branch slack/1234. !reset first to switch branches."
- Unknown repo name: list available repos

**Test:** `!repo example-frontend` then `!build fix styles` → worktree in example-frontend. `!branch staging` → next worktree branches from staging. `!repo nonexistent` → "Available repos: example-backend, example-frontend."
**Defers:** !help, verbosity.

### Iteration 3: !quiet, !verbose, !normal, !help (~15 min)

**What it adds:**
- `!quiet` → `session.verbosity = "quiet"`, reply "Quiet mode — status updates disabled."
- `!verbose` → `session.verbosity = "verbose"`, reply "Verbose mode — full event stream."
- `!normal` → `session.verbosity = "normal"`, reply "Normal mode."
- `!help` → reply with formatted list of all commands and descriptions

**Test:** `!help` → shows all commands. `!quiet` → acknowledged. Next Claude run → no status updates.
**Defers:** Per-channel defaults, per-user preferences.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Unknown commands treated as prompts (no error) | By design — reduces friction |
| No argument validation on !branch | Iteration 2 (ref existence check) |
| No persistence of command state across bot restarts | session-management iteration 4 (Redis) |

## Cut List (true v2)

- `!pr` — create PR from worktree branch
- `!diff` — show current worktree changes
- `!commit [message]` — commit worktree changes
- `!push` — push worktree branch
- `!logs` — show recent Claude execution logs
- `!config` — show/edit thread configuration
- Interactive Slack modals for complex commands
