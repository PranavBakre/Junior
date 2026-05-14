# Interactive Claude Driver

> Drive Claude Code as a persistent TTY session (tmux) instead of one short-lived `claude -p` per turn. Forced by Anthropic's pricing change: `claude -p` (headless) is moving off Max subscription onto separate API credits, while interactive TUI usage stays under the subscription. Coexist with the current headless driver behind a flag; flip the default per-thread once the new path is proven.

## Problem

Today every Slack message spawns a new `claude -p <prompt> --resume <id> --output-format stream-json` process. The process exits after one turn, the parser drains stream-json, the session manager picks up the result. Clean and stateless.

Anthropic is changing the terms: the headless `-p` flag will be billed against API credits, not the Max subscription. Only the interactive TUI session counts as subscription usage. That removes the substrate the project was built on — every Slack turn currently costs API credits we don't want to spend.

**Who has this problem:** The whole bot. Every Slack message turn runs through `spawnClaude`. Bug-pipeline persistent agents (lead, reproducer, thinker, review) are particularly exposed — they fan out and would burn through credits fastest.
**What happens today:** `src/claude/spawner.ts` calls `Bun.spawn(["claude", "-p", ...])` and pipes stream-json out of stdout. There is no driver abstraction — the spawner *is* the driver, baked into the session manager.
**Painful part:** Interactive Claude does not emit `--output-format stream-json`. It paints a TUI: ANSI escapes, cursor positioning, redraws. The whole event pipeline (init→tool_use→text→result) we depend on for live Slack status pills, session-id extraction, and turn completion has no obvious equivalent. We need a different signal channel — and process lifecycle is no longer "exit = done."
**"Finally" moment:** A Slack message arrives, `driver.send(session, prompt)` pastes it into the thread's already-running `claude` TUI inside a detached tmux session, hooks fire as Claude works, the bot streams `tool_use` pills exactly like today, and a `Stop` hook fires the "turn done" signal. The Claude process never exits between turns. Bot restart re-attaches to the surviving tmux sessions. `CLAUDE_DRIVER=tmux` per thread (or globally) chooses this path; `CLAUDE_DRIVER=headless` is the fallback that still works for any code path that can tolerate API billing (utility commands, throwaway one-shots).

## Full Vision

- **Driver interface.** `ClaudeDriver` exposes `send(session, prompt, options)`, `interrupt(session)`, `close(session)`. Two implementations: `HeadlessDriver` (today's `spawnClaude`, renamed) and `TmuxDriver` (new).
- **TmuxDriver — one tmux session per `(threadId, agentName)`.** Session name is `junior-<threadId>-<agentName>` (truncated to tmux's 200-char cap). Started with `tmux new-session -d -s <name> -c <cwd> "claude --append-system-prompt ... --mcp-config ... [--resume <id>] [--model <m>]"`. The Claude TUI runs forever inside it until evicted.
- **Input via paste-buffer, not send-keys.** `tmux load-buffer -b <buf> <(printf '%s' "$prompt")` followed by `tmux paste-buffer -p -b <buf> -t <session>` then `tmux send-keys -t <session> Enter`. `-p` enables bracketed paste — Claude's input box handles this cleanly, including multi-line prompts and special chars. Plain `send-keys` for the prompt text is rejected: it breaks on backticks, `$`, embedded newlines, and bracketed-paste-aware input boxes.
- **Events from the transcript file, not the TUI.** Claude Code writes a per-session JSONL transcript to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. The TmuxDriver tails this file and translates each line into the existing `StreamEvent` shape via a transcript-adapter. The TUI render is for humans attaching to debug; the bot never reads it. **Iter 0 finding:** the transcript carries `assistant` events with the same `message.content` shape `parser.ts` already handles, plus extra metadata (`uuid`/`parentUuid`/`timestamp`/`cwd`/`gitBranch`) and extra event types (`user`, `attachment`, `ai-title`, `pr-link`, `permission-mode`, `last-prompt`, `file-history-snapshot`, `system.*`) the adapter filters out.
- **Turn boundary via the `system.turn_duration` event.** Iter 0 superseded the original Stop-hook-plus-sentinel design. Every interactive turn ends with a line of shape `{"type":"system","subtype":"turn_duration","durationMs":N,"messageCount":N,"sessionId":"..."}` in the transcript. The TmuxDriver watches for this and resolves the in-flight `send()` promise off it — no `~/.claude/settings.json` modification, no sentinel directory, no second watcher path. The transcript is the single signal channel for both events and turn boundary. (The companion `system.stop_hook_summary` event also fires at the same boundary and can be a redundancy check if `turn_duration` is ever missed.)
- **Session-id discovery on first turn.** When tmux first launches `claude` without `--resume`, the session ID isn't known until Claude creates the transcript file. The driver finds it by watching `~/.claude/projects/<encoded-cwd>/` for the newest `*.jsonl` written after the tmux session start time. From the second turn on it's persisted on `ThreadSession.sessionId` like today.
- **Bot-boot reconciliation.** On startup, the bot reads every session row with `driverMode = "tmux"` from sqlite. For each, runs `tmux has-session -t <name>`. If present: re-attach the transcript tail and Stop-signal watch — no state lost. If absent: mark `sessionId` stale and downgrade `status` to `idle` so the next turn cold-starts a fresh tmux session via `--resume <sessionId>` against the still-on-disk transcript.
- **Eviction.** A background sweep kills tmux sessions whose `lastActivity` is older than `TMUX_IDLE_TTL_MS` (default 4h). Eviction = `tmux kill-session -t <name>`. The next Slack message spins it back up via `--resume`. RAM cost is bounded by active threads, not lifetime threads.
- **Interrupts.** `driver.interrupt(session)` sends `Escape` keys (`tmux send-keys -t <name> Escape Escape`) to halt mid-turn. New in v2 — today's buffer-and-drain has no equivalent. Used by `!stop` thread command.
- **Coexistence flag.** `ThreadSession.driverMode: "headless" | "tmux"`. Default selected by env `DEFAULT_CLAUDE_DRIVER=headless`. Per-thread override via `!driver tmux` / `!driver headless` for testing. The session manager picks `HeadlessDriver` or `TmuxDriver` from the session row — no other call site changes.

## Invariants (architectural commitments)

1. **The transcript file is the event source of truth.** Never parse the TUI render. Stale display state is acceptable; stale events are not.
2. **One tmux session per `(threadId, agentName)`.** Never share a tmux session across agents or threads — concurrent send-keys races corrupt input.
3. **Bracketed paste, always.** Every prompt goes through `load-buffer` + `paste-buffer -p`. `send-keys` is reserved for non-text control (Enter, Escape).
4. **tmux session name is deterministic from `(threadId, agentName)`.** Reconciliation depends on this — never store random session names.
5. **Headless driver stays.** Some paths (cleanup utilities, one-shot commands with `session.cwd` overrides, anything where API billing is acceptable) keep using `claude -p`. Driver choice is per-session, not per-bot.

## Dependencies

- [claude-spawner.md](claude-spawner.md) — current headless implementation; refactored into one driver behind the new interface.
- [session-management.md](session-management.md) — session map gains `driverMode`, `tmuxSessionName`; status transitions move from "process exit" to "Stop signal."
- [session-persistence.md](session-persistence.md) — sqlite schema gains two columns; bot-boot reconciliation queries them.
- [stream-to-slack.md](stream-to-slack.md) — unchanged consumer; events arrive via the same `onEvent` shape regardless of driver.
- [process-lifecycle.md](process-lifecycle.md) — timeout/health/shutdown all rewire: process death is no longer the failure signal. Timeout = "no Stop hook within N minutes." Health = `tmux has-session`. Shutdown = `tmux kill-session` per active row.
- [persistent-agents.md](persistent-agents.md) — bug-pipeline persistent agents map cleanly onto one tmux session per `(threadId, agentName)`; `agentSessions` already has the right shape.
- [thread-commands.md](thread-commands.md) — new `!driver`, `!stop`; `!reset` extends to `tmux kill-session`.

## Data Model

```typescript
type DriverMode = "headless" | "tmux";

interface ThreadSession {
  // ... existing fields ...
  driverMode: DriverMode;            // default from env, override per thread; thread-level decision
  tmuxSessionName: string | null;    // null until first turn; deterministic after — used when thread has no agent sub-sessions
}

interface AgentSession {
  // ... existing fields ...
  tmuxSessionName: string | null;    // inherits driverMode from parent ThreadSession; only the per-agent tmux name lives here
}

interface ClaudeDriver {
  send(session: SessionRef, prompt: string, opts: SendOptions): Promise<SpawnResult>;
  interrupt(session: SessionRef): Promise<void>;
  close(session: SessionRef): Promise<void>;
  isAlive(session: SessionRef): Promise<boolean>;
  onEvent(session: SessionRef, cb: (e: StreamEvent) => void): Unsubscribe;
}

type SessionRef = { threadId: string; agentName: string };
```

`SpawnResult` shape is unchanged — `{ sessionId, response, events, exitCode, error }`. `exitCode` becomes `0` on Stop, `null` on interrupt, non-zero on tmux-level failure.

Sqlite migration:

```sql
ALTER TABLE sessions ADD COLUMN driver_mode TEXT NOT NULL DEFAULT 'headless';
ALTER TABLE sessions ADD COLUMN tmux_session_name TEXT;
ALTER TABLE agent_sessions ADD COLUMN tmux_session_name TEXT;
-- driver_mode lives only on sessions; agent_sessions inherits
```

## Iterations

### Iteration 0: Manual tmux + transcript-tail smoke test (~1h)

Prove the substrate works end-to-end, outside the bot.

**What it adds:**
- Pre-check: `tmux -V` ≥ 3.4 (required for `paste-buffer -p` bracketed-paste flag). Document install path for older boxes.
- Shell script that:
  - Starts a tmux session running `claude` in a throwaway cwd
  - Pastes "say hello and exit gracefully" via `load-buffer` + `paste-buffer -p` + Enter
  - Tails `~/.claude/projects/<encoded-cwd>/*.jsonl` (newest) and prints events
  - Waits for a manually-installed Stop hook to write a sentinel file
- Confirms: bracketed paste works, transcript JSONL contents match the parser's expected event shapes, Stop hook fires reliably, `--append-system-prompt` and `--mcp-config` are accepted by interactive `claude`.

**Success criteria (must all hold before Iter 1):**
- Bracketed paste handles multi-line + special chars without truncation.
- Transcript JSONL contains `assistant` / `tool_use` / `tool_result` events recognizable by `parser.ts` — note: on-disk lines carry extra envelope fields (`uuid`, `parentUuid`, `timestamp`) the stream-json output omits, so plan a thin adapter for Iter 2.
- Stop hook fires on every turn boundary across N≥10 turns with zero misses.
- `--resume <id>` against the existing transcript continues the conversation in a fresh tmux session.

**Defers:** All TypeScript, driver interface, session manager wiring, eviction.

**Output of this iteration is a go/no-go on the design.** If any success criterion fails, the design changes before Iter 1 starts.

### Iteration 1: Driver interface refactor (~1.5h)

Refactor without behavior change.

**What it adds:**
- New `src/claude/driver.ts` — `ClaudeDriver` interface, `SessionRef`, `SendOptions`.
- `src/claude/headless-driver.ts` — wraps current `spawner.ts` behind the interface. `spawnClaude` becomes `headlessDriver.send`.
- `src/claude/factory.ts` — `createDriver(mode, config)` returns `HeadlessDriver | TmuxDriver` (TmuxDriver stub returns "not implemented").
- `session/manager.ts` — calls `driver.send(...)` instead of `spawnClaude(...)`. Driver picked from `session.driverMode`.
- Sqlite migration: add `driver_mode` columns (default `'headless'`), `tmux_session_name`.

**Test:** Full existing test suite green. Every Slack flow that worked before still works — only the call path changed.
**Defers:** TmuxDriver implementation.

### Iteration 2: TmuxDriver minimum viable (~3h)

One thread, one agent, happy path only.

**What it adds:**
- `src/claude/tmux-driver.ts`:
  - `start(session)` — `tmux new-session -d -s <name> -c <cwd> "claude ..."` with the same args the headless path builds (minus `-p` and `--output-format stream-json`).
  - `send(session, prompt)` — paste-buffer the prompt, send Enter, await Stop signal.
  - Stop signal: `chokidar` watch on `data/tmux-signals/`. Sentinel file `<sessionName>.stop` resolves the promise.
  - Transcript tail: `chokidar` watch on `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Parse new lines with the existing parser. Fire `onEvent` for each.
  - Session-id discovery: on first turn (no `--resume`), watch the project dir for the newest `*.jsonl` created after tmux start. Persist the discovered id.
- `~/.claude/settings.json` template/check that ensures a `Stop` hook writes the sentinel. Document the install in `docs/features/project-setup.md`.

**Test:** Set `CLAUDE_DRIVER=tmux` for one Slack thread. Send a message. See the Claude TUI run (attach with `tmux attach -t junior-<threadId>-junior` for debugging). See events stream into Slack via the same status pill code. Second message in the same thread reuses the tmux session — no `claude` re-launch.
**Defers:** Reconciliation on restart, eviction, interrupts, multi-agent, error handling, `!driver` command.

### Iteration 3: Reconciliation on bot restart (~1h)

Survive bot crashes.

**What it adds:**
- On bot boot, for every session row with `driverMode = 'tmux'`:
  - Run `tmux has-session -t <name>`. If true: re-attach transcript tail and Stop watcher.
  - If false but `sessionId` is set: leave `tmuxSessionName` null, leave `sessionId` set. Next `send()` will start a fresh tmux session with `--resume <sessionId>` against the still-on-disk transcript — Claude continues the conversation, just in a new tmux session.
  - If neither: cold start.
- Mark threads whose tmux died mid-turn (`status: "busy"` but no tmux session) as `failed` with `lastError = "tmux session lost"`. Surface via `!status`.

**Test:** Start a tmux-mode thread, send a message, kill the bot mid-turn with `SIGKILL`. Restart. Verify: (a) tmux session is still there, (b) bot re-attaches, (c) if turn already completed, Stop signal was either consumed (idle) or detected on reconcile, (d) next message works.
**Defers:** Eviction, interrupts.

### Iteration 4: Eviction and lifecycle (~1h)

Bound RAM.

**What it adds:**
- Background sweep every `TMUX_SWEEP_INTERVAL_MS` (default 15min). For each tmux-mode session where `now - lastActivity > TMUX_IDLE_TTL_MS` (default 4h):
  - Skip if `status === "busy"`.
  - `tmux kill-session -t <name>`. Null out `tmuxSessionName`. Keep `sessionId` — next message resumes.
- Graceful shutdown: on bot `SIGTERM`, do NOT kill tmux sessions (they should survive bot restart). Just close transcript tails and Stop watchers.
- `!status` shows `driver: tmux`, tmux session liveness, age.

**Test:** Set TTL to 1min. Send a message, wait, see eviction in logs. Send a second message — see `claude` re-launched with `--resume`. Conversation continues.
**Defers:** Interrupts.

### Iteration 5: Interrupts and `!driver` (~1h)

User control.

**What it adds:**
- `driver.interrupt(session)`:
  - HeadlessDriver: today's `proc.kill()` (existing buffer-and-drain semantics — no real interrupt; the doc says "use after current turn exits").
  - TmuxDriver: `tmux send-keys -t <name> Escape Escape`, then mark in-flight `send()` promise as cancelled. Claude's TUI handles the escape natively.
- `!stop` thread command — calls `driver.interrupt(session)`.
- `!driver tmux` / `!driver headless` thread command — flips `session.driverMode`. If switching to headless, `tmux kill-session`. If switching to tmux, next turn cold-starts.
- `!reset` extends to `tmux kill-session` for tmux-mode sessions.

**Test:** Mid-turn `!stop` halts the agent and lets the next message proceed without buffer drain. `!driver headless` on a tmux thread evicts the tmux session and falls back.
**Defers:** Multi-agent (already works as a consequence of `(threadId, agentName)` keying — write integration test in Iter 6).

### Iteration 6: Multi-agent (bug-pipeline) coverage (~1.5h)

Persistent agents on tmux.

**What it adds:**
- Verify `AgentSession.driverMode` flows through `persistent-agents.md` dispatch.
- Each `(threadId, agentName)` gets its own tmux session — lead, thinker, reproducer, review have four parallel tmux sessions when active.
- Eviction policy applied per-agent-session, not per-thread (a thread's reproducer can be evicted while lead stays warm).
- Integration test: full bug-pipeline run in tmux mode, parallel agents, status pills correct, all four tmux sessions reconciled after a forced bot restart mid-flight.

**Test:** Trigger a bug thread with `DEFAULT_CLAUDE_DRIVER=tmux`. Watch lead → reproducer → thinker → review fan out across four tmux sessions. Restart bot mid-pipeline. Pipeline resumes.
**Defers:** Default flip.

### Iteration 7: Default flip (~30min + soak)

Make tmux the default once it's earned trust.

**What it adds:**
- `DEFAULT_CLAUDE_DRIVER=tmux` in production env.
- Documentation update — runbook for attaching to a thread's tmux session for debug (`tmux attach -t junior-<threadId>-<agentName>`).
- Keep headless path alive for utility commands (`session.cwd` overrides — see `spawner.ts:24`).

**Test:** One week of real usage. No regressions in latency, no orphaned tmux sessions, no Stop-hook misses.
**Defers:** Headless removal — deferred indefinitely, kept for utility commands.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| No interrupt on headless (today's behavior) | Iteration 5 (tmux gets real interrupts; headless stays buffer-and-drain) |
| Sentinel files for Stop signal instead of an MCP hook callback into the bot | Post-MVP — sentinel + chokidar is simple and reliable; revisit only if it doesn't scale |
| Transcript tail re-parses every chunk fresh on restart | Acceptable; transcript files are small (one thread-day = single-digit MB) |
| Eviction TTL is a flat number | Post-MVP (per-agent override if memory pressure shows up) |
| `tmux` command shelled out as a string | Post-MVP (consider node-pty if shell-out latency dominates) |

## Cut List (true v2)

- **node-pty / native PTY** replacement for tmux. Worth it only if (a) we hit a tmux-specific bug or (b) shell-out latency dominates per-turn time. tmux's "attach with your terminal to debug" property is high value; don't trade it away early.
- **Claude Code's bidirectional `--input-format stream-json`** if it ships stable. Would obviate this entire feature — but the project rule (#10 in CLAUDE.md) explicitly bans it until specified. Revisit when Anthropic documents it.
- **Pre-warm pool of idle tmux sessions** to amortize cold-start. Cold start is ~2-3s today via `claude -p`; persistent tmux removes cold start entirely from turn 2 onward, so pooling solves a non-problem.
- **Headless removal.** Don't. Utility paths with `session.cwd` overrides (one-off cloud integrations) are fine on API credits. Two drivers, forever.

## Open Questions

1. **Anthropic terms — scope and timeline.** Confirm with a primary source (a) that the billing change is real, (b) the exact boundary it draws — `-p` from any context vs `-p` from a non-TTY vs all non-interactive usage, and (c) when it takes effect. The whole forcing function dissolves if the rule is narrower than assumed (e.g. `-p` from inside an attached TUI still counts as subscription). **Action: confirm before Iteration 1.**
2. **Stop hook reliability under load.** If a hook misfires (Claude crashes mid-turn before the hook), the driver hangs forever. Mitigations, in order: per-turn timeout watchdog declares turn failed; PostToolUse hooks as a heartbeat side-channel (every tool call writes its own signal, absence-of-signal-for-N-seconds = stuck); `tmux capture-pane` polling as last resort. Validate in Iteration 0.
3. **Hook-channel fallback for events, not just turn boundary.** If transcript-tail proves flaky in Iter 0 (file races, version drift, etc.), PostToolUse / PreToolUse / UserPromptSubmit hooks can carry structured events directly. Worth keeping in mind so it isn't a fresh design decision under pressure later.
4. **Transcript JSONL stability.** The file format is internal to Claude Code and could change between versions. Mitigation: pin the Claude Code version, add a parser-version check on startup, fail loudly. Validate in Iteration 0.
5. **Image input.** Slack attachments today are passed via `thread-context.md` paths. Interactive Claude accepts file paths in prompt text the same way. No change expected — but verify with a real image upload in Iteration 2.
6. **Concurrent send-keys.** If two messages race into `driver.send()` for the same session, we get interleaved input and corruption. The session manager's `status: "busy"` guard prevents this today; ensure the same guard is honored end-to-end through the driver interface.
