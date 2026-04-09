# Code Index: Bot Slack MCP Server

Shared HTTP MCP server running inside Junior's process. All spawned Claude instances connect to it for Slack operations using the bot token.

## Code Index

### src/mcp

| Function | File | Purpose |
|----------|------|---------|
| `startMcpServer(botToken)` | `slack-server.ts` | Starts HTTP server on `MCP_PORT`, called once from `index.ts` |
| `registerTools(server)` | `slack-server.ts` | Registers all 6 tools on an McpServer instance |

### Tools

| Tool | Slack API | Required params | Optional params |
|------|-----------|-----------------|-----------------|
| `slack_send_message` | `chat.postMessage` | `text`, `channel_id` | `thread_ts`, `reply_broadcast` |
| `slack_read_channel` | `conversations.history` | `channel_id` | `limit`, `oldest`, `latest` |
| `slack_read_thread` | `conversations.replies` | `channel_id`, `thread_ts` | `limit` |
| `slack_search` | `search.messages` | `query` | `count`, `sort` |
| `slack_search_users` | `users.list` (filtered) | `query` | — |
| `slack_upload_file` | `files.getUploadURLExternal` | `file_path`, `channel_id` | `thread_ts`, `comment` |

### Configuration

| File | What |
|------|------|
| `.mcp.json` | `{ "type": "http", "url": "http://localhost:3456/mcp" }` |
| `.claude/settings.json` | `permissions.allow: ["mcp__slack-bot__*"]` |
| `src/claude/spawner.ts` | Passes `--mcp-config` for worktree spawns |

## Key Concepts

### Stateless Per-Request

Each HTTP request creates a fresh `McpServer` + `StreamableHTTPServerTransport`. No sessions, no state between requests. All instances share the same `WebClient` (module-level singleton).

### Identity Model

Messages sent via `slack_send_message` carry Junior's `bot_id`. The event handler at `events.ts:31` filters by `selfBotId`, preventing loops. This is why this server replaces the Slack plugin (which sent as the user's OAuth identity).

## Dependencies

- **Uses**: `@modelcontextprotocol/sdk` (McpServer, StreamableHTTPServerTransport), `@slack/web-api` (WebClient), `zod` (input schemas)
- **Used by**: spawned Claude instances (via HTTP), `index.ts` (startup)
