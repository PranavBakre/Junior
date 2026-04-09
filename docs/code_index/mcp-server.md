# Code Index: Bot Slack MCP Server

## Files

| File | Purpose |
|---|---|
| `src/mcp/slack-server.ts` | Shared HTTP MCP server with Slack tools using bot token |

## Key Exports

### `src/mcp/slack-server.ts`
- `startMcpServer(botToken: string): void` — starts HTTP server on `MCP_PORT` (default 3456), called once from `index.ts`

## Internal Structure

- `registerTools(server: McpServer)` — registers all 6 tools on an McpServer instance
- `slack: WebClient` — module-level client initialized with bot token in `startMcpServer()`
- Each HTTP request creates a fresh `McpServer` + `StreamableHTTPServerTransport` (stateless mode, no sessions)

## Tools

| Tool | Slack API | Required params | Optional params |
|---|---|---|---|
| `slack_send_message` | `chat.postMessage` | `text`, `channel_id` | `thread_ts`, `reply_broadcast` |
| `slack_read_channel` | `conversations.history` | `channel_id` | `limit`, `oldest`, `latest` |
| `slack_read_thread` | `conversations.replies` | `channel_id`, `thread_ts` | `limit` |
| `slack_search` | `search.messages` | `query` | `count`, `sort` |
| `slack_search_users` | `users.list` (filtered) | `query` | — |
| `slack_upload_file` | `files.getUploadURLExternal` | `file_path`, `channel_id` | `thread_ts`, `comment` |

## Configuration

| File | What |
|---|---|
| `.mcp.json` | `slack-bot` server: `{ "type": "http", "url": "http://localhost:3456/mcp" }` |
| `.claude/settings.json` | `permissions.allow: ["mcp__slack-bot__*"]` |
| `src/claude/spawner.ts` | Passes `--mcp-config` for worktree spawns (points to project `.mcp.json`) |

## Dependencies

- `@modelcontextprotocol/sdk` — `McpServer`, `StreamableHTTPServerTransport`
- `@slack/web-api` — `WebClient` (transitive from `@slack/bolt`)
- `zod` — tool input schemas (transitive from MCP SDK)
