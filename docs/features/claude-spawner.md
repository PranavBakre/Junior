# Claude CLI Spawner

## Role

Execution layer between [session-management](session-management.md) and the `claude` CLI. Given a session and a prompt, it builds args, spawns the process, streams output back to listeners, and resolves a final `SpawnResult` on exit.

## Public surface

- `spawnClaude(session, prompt, config, targetRepoCwd?, botToken?, agentIdentity?) -> SpawnHandle`
- `SpawnHandle = { result, onEvent, kill, pid }`
- `SpawnResult = { sessionId, response, events, exitCode, error }`

Session manager calls `spawnClaude`, subscribes via `onEvent` (consumed by [stream-to-slack](stream-to-slack.md) for status pills), and awaits `result`.

## Arg building (`args.ts`)

Always: `-p <prompt>`, `--output-format stream-json`, `--verbose`, `--max-turns`, `--permission-mode` (from config).

Conditional:
- `--resume <id>` if `session.sessionId` is set
- `--append-system-prompt` if `session.systemPrompt` (composed upstream by [agent-routing](agent-routing.md) — spawner does not load agent files)
- `--model` from `session.model ?? config.defaultModel`
- `--mcp-config <path>` only when an mcp config path is passed in

## Spawn (`spawner.ts`)

- `cwd` precedence: `session.cwd` (utility commands) -> `session.worktreePath` (per-thread worktree, see [worktree-manager](worktree-manager.md)) -> `targetRepoCwd` -> `process.cwd()`
- If `session.cwd` is set, it's `mkdirSync`'d first (e.g. `/tmp/junior-utility` for `!adhoc` / `!bugs`). This keeps utility commands away from any project `CLAUDE.md`.
- `--mcp-config` points at junior's `.mcp.json` (so worktrees can reach the slack-bot MCP server, see [mcp-server](mcp-server.md)). Skipped when `session.cwd` is an override — utility commands rely on cloud integrations, not local MCP.
- Env passed to child: `JUNIOR_SPAWNED=1`, `SLACK_CHANNEL`, `SLACK_THREAD_TS`, `JUNIOR_AGENT_NAME`, optional `JUNIOR_SLACK_USERNAME` / `JUNIOR_SLACK_ICON_EMOJI` (per-agent identity for [mcp-server](mcp-server.md) postings, see [thread-context](thread-context.md)), and `SLACK_BOT_TOKEN` when provided.

Process is `Bun.spawn(["claude", ...args])` with piped stdout/stderr. `kill()` forwards to the child; lifecycle (timeout, zombie cleanup) lives in [process-lifecycle](process-lifecycle.md).

## Stream parsing (`parser.ts`, `types.ts`)

Line-buffered reader over stdout chunks. Each newline-terminated line is `JSON.parse`d and shape-checked by `isStreamEvent`. Unknown / malformed lines are skipped silently — the CLI's event vocabulary evolves.

Recognized events (`StreamEvent`):
- `system` subtype `init` -> carries `session_id`, captured once
- `assistant` -> `message.content[]` of `text` / `tool_use` / `thinking` blocks; the most recent assistant turn's text is held as a fallback response
- `result` -> `result` or `text` is the final response
- `user`, `rate_limit_event` -> passed through to listeners

## Exit handoff

On `proc.exited`:
- `response = resultText || lastAssistantText` (fallback covers turns that end without a `result`)
- Non-zero exit reads `stderr` into `error`
- Returns `{ sessionId, response, events, exitCode, error }` to the session manager, which posts the response (subject to thread-level `!mute` from [thread-commands](thread-commands.md)) and drains buffered messages.

## Configuration

From `config.claude`: `maxTurns`, `permissionMode`, `defaultModel`. Per-session overrides on `ThreadSession`: `sessionId`, `systemPrompt`, `model`, `worktreePath`, `cwd`, `channel`, `threadId`, `activeAgentName`.
