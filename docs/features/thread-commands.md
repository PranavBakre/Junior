# Thread Commands

## Problem

Users need to control thread behavior beyond just sending messages. Reset a broken session, check what's running, switch agent types, change the target repo or branch. These are control-plane operations that don't need Claude — the bot handles them directly.

**Who has this problem:** Users managing active Slack threads.
**What happens today:** Junior handles thread controls directly in
`SessionManager`; persistent-agent directives are routed separately by
`AgentDispatcher` and are not part of `KNOWN_COMMANDS`.
**Painful part:** Namespace collision. `!build fix auth` is a command + prompt. `!reset` is a pure command. `!status` might be a Slack-native command. Need clean parsing that doesn't conflict with Slack's built-in slash commands.
**"Finally" moment:** `!status` → "Session active. Agent: build. Worktree: slack/1234. Last activity: 2 min ago." `!reset` → "Session cleared." Everything feels controllable.

## Full Vision

- `!reset <agent|all>` — Clear one agent's slice of the session, or the whole thread. Bare `!reset` is rejected with usage help so admins don't accidentally nuke an active reproducer/thinker turn. (admin only)
- `!clear` — Archive the full thread to markdown on disk, then delete all Junior bot messages from the thread. Session state is untouched. (admin only)
- `!status` — Show session state (agent type, worktree, busy/idle, last activity, pending messages count)
- `!build [prompt]` — Set agent to build, create worktree if needed, run prompt
- `!frontend [prompt]` — Set agent to frontend, create worktree, run prompt
- `!review` — Dispatch to the persistent review agent. It is not a normal
  `KNOWN_COMMANDS` command; the support router handles the directive.
- `!architect [prompt]` — Set agent to architect, run prompt
- `!repo <name>` — Switch target repo for this thread
- `!branch <ref>` — Set worktree base ref (next worktree creation uses this)
- `!quiet` / `!normal` / `!verbose` — Set verbosity
- `!mute` — Stop seeing or replying to any messages until `!unmute` (admin only)
- `!unmute` — Resume normal operation (admin only)
- `!aside [text]` — Drop just this message; everything else in the thread continues as normal. For human-to-human sidebar without leaving the thread.
- `!listen` — Wake Junior back up from auto-dormant mode. Anyone in the thread can use it.
- `!help` — List available commands
- `!provider <name>` — Switch the thread's runner provider (`claude`,
  `opencode`, `opencode-sdk`, or `codex-app-server`)
- `!stop` — Stop the active runner/driver
- `!driver <headless|tmux>` — Select Claude's driver mode for the thread
- `!workflow ...` / `!workflows` — Inspect and control dynamic workflows

## Admin-only commands

`!mute`, `!unmute`, `!reset`, and `!clear` are admin-gated. Two tiers:

1. **Env bootstrap** — `ADMIN_SLACK_USER_ID` names one Slack user ID. This is the bootstrap admin; the system stays bootable on a fresh DB.
2. **SQLite extras** — the `admins` table in the session DB (`data/sessions.db`) lists additional admins. Added by **direct SQL only** (no Slack command, no CLI script — intentional minimal UX):
   ```sql
   INSERT INTO admins (slack_user_id, added_at)
   VALUES ('U0XXXX', strftime('%s','now') * 1000);
   ```
   `isAdmin` reads the table on every check (no cache), so inserts take effect on the next command without a restart.

Permissions are flat — anyone in either tier can run any admin command. Non-admin invocations are silently rejected with a ❌ reaction on the trigger message — no thread reply, no log noise.

**Open-mode** (everyone admitted): only when **both** tiers are empty (env unset AND `admins` table empty). A partial misconfiguration — env unset but DB populated — still rejects unlisted users. This guards against an env-reload misfire silently promoting everyone in prod.

The thread-owner-can-run-elevated-commands idea is still v2 — see [v2-backlog.md](v2-backlog.md).

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
  Worktree: example-backend.junior-worktrees/slack-1234
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

### Iteration 4: !aside, auto-dormant, !listen (~45 min)

The problem this solves: a thread that started with Junior often turns into a human-to-human conversation that Junior keeps replying to because the routing is still active. `!mute` exists but is admin-only and overkill — it silences the bot everywhere. We need a thread-local, anyone-can-use control surface for attention.

**The signal that matters is "addressed to me", not "number of participants".** Counting humans is a tempting proxy but misfires both ways. The real trigger is whether the current message continues Junior's conversation or starts a sidebar between humans. See `learnings.md` — same principle generalises to any bot in a shared channel.

**What it adds:**

- `!aside [text]` — drop the current message before it reaches any agent. React with 👀 so the user knows it landed; do not spawn Claude. Anyone in the thread. Cheap, no state change.

- **Auto-dormant trigger** — when a human who has never directly engaged Junior in this thread posts a message that does NOT @mention Junior AND at least one other human has already posted in the thread, set `session.dormant = true`, post a single notice to the thread:
  > Two people are interacting here, so I’ll stop replying. @ me or use !listen to bring me back.

  After that, drop every message in the thread except:
    - `!listen` (wake)
    - `!aside` (still works — it's a no-op anyway)
    - any message that @mentions Junior (wake)

  Track `humanParticipants: string[]` on the session — append on every human message (not Junior, not its agents, not other bots). Also track `engagedHumans: string[]` — the subset who have directly engaged Junior: their message @mentioned it, routed to a runner turn, or they summoned it with `!listen`. Decision rule: if the set already contains a user other than the current sender AND the current message doesn't @mention Junior AND the sender has never engaged Junior → go dormant.

  The engagement check is what keeps a genuinely mixed conversation alive: once a second human @mentions Junior (or Junior has been replying to them), their plain follow-ups — and the first human's — are continuation of a conversation *with* Junior, not a sidebar. Without it the very next untagged message after Junior replies would falsely trip the trigger. `!aside` posters and the sender whose sidebar message fired the trigger are participants but never engaged, so a lurker who only whispered asides still trips the gate with their first real message.

- `!listen` — set `session.dormant = false`, react with 👂 (or post a short ack). Anyone in the thread.

- **Bot identity rule** — Junior and its agents (lead, reproducer, thinker, scotty, uhura, bones, etc.) share the same Slack `bot_id` and are never participants. Other bots (Friday, Doraemon, CI webhooks, foreign assistants) are not counted either — they're not conversation partners.

**Persistence:** `dormant: boolean`, `humanParticipants: string[]`, and `engagedHumans: string[]` persist on the session row in SQLite. Survives restart so a dormant thread doesn't auto-resume on bot bounce.

**Wake by @mention:** `app_mention` events always wake the thread before routing. The mention itself is the explicit "I'm talking to you again" signal.

**Test:** Thread with one human + Junior — chats freely, never goes dormant. Second human joins and @mentions Junior — wakes (no-op, wasn't dormant), and their untagged follow-ups keep routing (engaged) — as do the first human's. Second never-engaged human posts without mention while first human is also present — dormant, notice posted once. Subsequent messages dropped silently. `!listen` from either human — wakes, next message routes normally. `!aside fyi I have to step out` — dropped, 👀 reaction, thread state unchanged.

**Defers:** Per-user wake (only the thread owner can `!listen`), time-based auto-wake, configurable trigger threshold.

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
