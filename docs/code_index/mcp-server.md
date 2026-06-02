# Code Index: Bot Slack MCP Server

Shared HTTP MCP server running inside Junior's process. All spawned Claude instances connect to it for Slack operations using the bot token.

## Code Index

### src/mcp

| Symbol | File | Purpose |
|---|---|---|
| `startMcpServer(botToken, store?, worktreeManager?)` | `slack-server.ts` | Starts HTTP server on `MCP_PORT` (default 3456). Called once from `index.ts`. |
| `registerTools(server)` (internal) | `slack-server.ts` | Registers Slack, worktree, and agent-registry tools on a fresh `McpServer` per request. |
| `searchAgentDefinitions(options)` | `slack-server.ts` | Reads public/private agent markdown files and returns matching definitions plus dispatch registration state. |

### Tools

| Tool | Slack/Junior API | Required | Optional |
|---|---|---|---|
| `slack_send_message` | `chat.postMessage` | `text`, `channel_id` | `thread_ts`, `reply_broadcast`, `username`, `icon_emoji` |
| `slack_read_channel` | `conversations.history` | `channel_id` | `limit`, `oldest`, `latest` |
| `slack_read_thread` | `conversations.replies` | `channel_id`, `thread_ts` | `limit` |
| `slack_search` | `search.messages` | `query` | `count`, `sort` |
| `slack_search_users` | `users.list` (filtered) | `query` | — |
| `slack_upload_file` | `files.getUploadURLExternal` + `completeUploadExternal` | `file_path`, `channel_id` | `thread_ts`, `comment` |
| `register_worktree` | Junior internal | `thread_id`, `repo` | `branch` (branch-name override) |
| `agent_search` | Junior internal | — | `query`, `include_public`, `include_private`, `limit` |
| `reload_agent_registry` | Junior internal | — | — |

### Configuration

| File | What |
|---|---|
| `.mcp.json` | `{ "type": "http", "url": "http://localhost:3456/mcp" }` |
| `.claude/settings.json` | `permissions.allow: ["mcp__slack-bot__*"]` |
| `src/claude/spawner.ts` | Passes `--mcp-config` for worktree spawns |

## Key Concepts

### Stateless per request

Each HTTP request creates a fresh `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`). No sessions, no state between requests. All instances share the same `WebClient` (module-level singleton).

### Identity model

Messages sent via `slack_send_message` carry Junior's `bot_id`. Optional `username` + `icon_emoji` per call let agents post under their own persona while the underlying identity stays junior's bot. The event handler (`events.ts`) filters by `selfBotId` to prevent loops — but messages with `!<persistent-agent>` directives are let through (see `slack-event-handler.md`).

### `register_worktree` tool

Called by lead/intake to create a per-thread worktree for a repo and persist its path into `session.worktreePaths[repoName]`. Multi-repo bug-pipeline support — `worktreePaths` keys are repo names from `REPOS` config. Refetch-then-mutate guards against concurrent session writes.

### Agent registry tools

`agent_search` scans `.claude/agents` and `agents-org` from disk and annotates each result with whether `AGENT_IDENTITIES` currently makes it dispatchable. `reload_agent_registry` reruns `loadOverlayIdentities("agents-org")`, which lets newly added private workers become dispatchable without a full process restart. Existing identities are not overwritten; prompts are already resolved from disk per turn.

## Dependencies

- **Uses**: `@modelcontextprotocol/sdk` (`McpServer`, `StreamableHTTPServerTransport`), `@slack/web-api`, `zod`, `SessionStore`, `WorktreeManager`
- **Used by**: spawned Claude instances (HTTP), `src/index.ts` (startup)
