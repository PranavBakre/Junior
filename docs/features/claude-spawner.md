# Claude CLI Spawner

## Problem

The bot needs to spawn Claude Code CLI processes, feed them prompts, parse their streaming output, and collect the final response. Each spawn must use the right flags (`--resume`, `--output-format stream-json`, agent definition, MCP config) and handle process lifecycle (exit, error, timeout).

**Who has this problem:** The session manager — it needs a clean interface to "run Claude and get a response."
**What happens today:** Nothing — this is the execution layer.
**Painful part:** stream-json parsing. The output is newline-delimited JSON with multiple event types. Session ID must be extracted from the first `init` event. The final response comes from the `result` event. Tool calls and thinking steps come as intermediate events. All of this arrives as raw stdout chunks that may split across JSON boundaries.
**"Finally" moment:** `spawnClaude(prompt, session)` → returns a structured response with session ID, response text, and tool call events.

## Full Vision

- Spawn `claude -p "<prompt>"` as child process
- Build args from session state: `--resume`, `--output-format stream-json`, `--append-system-prompt`, `--allowedTools`, `--disallowedTools`, `--max-turns`, `--mcp-config`
- Set `cwd` to worktree path (if code thread) or junior workspace (if non-code)
- Parse stream-json events line by line
- Extract session ID from `init` event
- Emit intermediate events (tool_use, text) for Slack status updates
- Collect final response from `result` event
- Handle process exit (code 0 = success, non-zero = error)
- Handle timeout (SIGINT after configurable duration)
- Handle errors (spawn failure, parse failure)

## Dependencies

- Claude Code CLI installed and authenticated (Max subscription)
- Session Manager provides session state (sessionId, worktreePath, agentType)
- Stream Parser (built as part of this feature)

## Iterations

### Iteration 0: Raw spawn and capture (~20 min)

Prove we can spawn `claude -p` and get output back.

**What it adds:** Function that spawns `claude -p "hello" --output-format stream-json`, collects stdout, logs each line. No parsing, no session management.
**Test:** Run the function. See raw stream-json output in console. Process exits cleanly.
**Defers:** Parsing, --resume, args building, error handling, timeouts.

### Iteration 1: Stream-json parser (~1h)

Parse the structured events from stdout into typed objects.

**What it adds:**
- Line-buffered stdout reader (handles chunks that split across JSON boundaries)
- Parse each line as JSON
- Type each event: `init`, `tool_use`, `text`, `result`, `error`
- Extract `session_id` from `init` event
- Extract final response text from `result` event
- EventEmitter or callback pattern: `onEvent(event)` fires for each parsed event
- Return value: `{ sessionId, response, events[], exitCode }`

**Test:** Spawn Claude with a simple prompt. `sessionId` is extracted. `response` contains the final text. `events` array has all intermediate events typed correctly. No parse errors on split chunks.
**Defers:** Arg building, --resume, timeouts, Slack status updates.

### Iteration 2: Arg builder (~30 min)

Build the full `claude` command args from session state.

**What it adds:**
- `buildClaudeArgs(session, prompt)` function
- Always: `-p`, `--output-format stream-json`, `--max-turns 25`
- If `session.sessionId`: add `--resume <id>`
- If `session.agentType`: load agent definition, add `--append-system-prompt`
- If MCP config exists: add `--mcp-config <path>`
- If `session.worktreePath`: set `cwd` to worktree
- If no worktree: set `cwd` to junior workspace or target repo root
- Permission mode: `--permission-mode bypassPermissions` (bot runs unattended)

**Test:** Session with sessionId → args include `--resume`. Session with agentType "build" → system prompt includes build agent definition. Session without worktree → cwd defaults to target repo root.
**Defers:** Allowed/disallowed tools config, MCP config generation.

### Iteration 3: Timeout and error handling (~30 min)

**What it adds:**
- Configurable timeout (default 5 min, env var override)
- On timeout: send SIGINT, wait 10s, then SIGKILL if still alive
- On process error (spawn failure, ENOENT): return error result, don't crash bot
- On non-zero exit: include stderr in error result
- On parse error (invalid JSON line): log and skip, don't abort the whole stream

**Test:** Spawn Claude with a prompt that takes forever (or mock a hanging process). Process killed after timeout. Error result returned to session manager. Bot stays alive.
**Defers:** Retry logic (don't retry — user re-sends).

### Iteration 4: Tool scoping (~30 min)

**What it adds:**
- `--allowedTools` and `--disallowedTools` from session config
- Default allowed: `Read, Write, Edit, Bash, Grep, Glob, Agent`
- Default disallowed: `Bash(rm -rf *)`, `Bash(sudo *)`
- Agent-type specific overrides: review agent gets `Read, Grep, Glob, Bash(git *)` only
- Configurable per-thread via `/allow` and `/deny` commands (post-MVP)

**Test:** Review session → Claude can read files and run git but can't write. Build session → full tool access except destructive commands.
**Defers:** Per-thread command overrides, dynamic tool scoping mid-session.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| No --resume on first message | Iteration 2 (handled naturally — sessionId is null) |
| Hardcoded max-turns 25 | Post-MVP (configurable per agent type) |
| No retry on failure | By design — user re-sends |
| bypassPermissions always | Post-MVP (configurable trust levels) |

## Cut List (true v2)

- `--input-format stream-json` bidirectional mode (undocumented, unstable)
- Streaming response to Slack in real-time (update message as chunks arrive)
- Claude Code SDK mode (if/when Max subscription works with SDK)
- Process pooling (pre-warm Claude processes for faster cold start)
