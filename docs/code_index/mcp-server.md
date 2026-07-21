# Code Index: Bot MCP Server

Shared loopback HTTP MCP server running inside Junior's process. All spawned
runners connect to it for Slack, memory, agent, and (when enabled) pipeline
operations using the bot token and signed run context.

## Code Index

### src/mcp

| Symbol | File | Purpose |
|---|---|---|
| `startMcpServer(deps)` | `slack-server.ts` | Starts HTTP server on `MCP_PORT` (default 3456), binding `127.0.0.1` and best-effort `::1`. Optional dependencies wire stores and pipeline services. |
| `registerTools(server)` (internal) | `slack-server.ts` | Registers Slack, worktree, and agent-registry tools on a fresh `McpServer` per request. |
| `handleMongoMcpRequest(req, res)` | `mongodb-proxy.ts` | Serves `/mcp/mongodb` as a stateless HTTP MCP proxy to one shared read-only MongoDB stdio backend. |
| `closeMongoMcpBackend()` | `mongodb-proxy.ts` | Closes the shared backend immediately; also used by the idle TTL. |
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
| `slack_send_dm` | Slack Web API | `user_id`, `text` | identity fields |
| `agent_dispatch` | Junior internal | agent, prompt, thread context | synthetic user/timestamp |
| `memory_recall` / `memory_add` / `memory_consolidate` | Memory v3 | tool-specific | filters/options |
| `github_read_pr_review_state` / `github_post_review` | Fixed GitHub API surface | review-specific | inline comments |
| `pipeline_*` | Durable pipeline store | tool-specific | artifact/check fields |
| `whatsapp_*` | Read-only archive | tool-specific | time/group filters |

### Configuration

| File | What |
|---|---|
| `.mcp.json` | Root config contains `slack-bot`, Figma, and Notion servers. Per-agent generated configs add Playwright/MongoDB as needed. |
| `.claude/settings.json` | `permissions.allow: ["mcp__slack-bot__*"]` |
| `src/claude/spawner.ts` | Passes `--mcp-config` for worktree spawns |

## Key Concepts

### Stateless per request

Each HTTP request creates a fresh `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`). No MCP session state is kept between requests. Slack requests share the same `WebClient` (module-level singleton). MongoDB proxy requests share one lazily started wrapped stdio backend and close it after an idle TTL. Run context is HMAC-signed per spawn and validated before thread/agent-sensitive tools execute.

### Identity model

Messages sent via `slack_send_message` carry Junior's `bot_id`. Optional `username` + `icon_emoji` per call let agents post under their own persona while the underlying identity stays junior's bot. The event handler (`events.ts`) filters by `selfBotId` to prevent loops — but messages with `!<persistent-agent>` directives are let through (see `slack-event-handler.md`).

### `register_worktree` tool

Called by lead/intake to create a per-thread worktree for a repo and persist its path into `session.worktreePaths[repoName]`. Multi-repo bug-pipeline support — `worktreePaths` keys are repo names from `REPOS` config. Refetch-then-mutate guards against concurrent session writes.

### Agent registry tools

`agent_search` scans `.claude/agents` and `agents-org` from disk and annotates each result with whether `AGENT_IDENTITIES` currently makes it dispatchable. `reload_agent_registry` reruns `loadOverlayIdentities("agents-org")`, which lets newly added private workers become dispatchable without a full process restart. Existing identities are not overwritten; prompts are already resolved from disk per turn.

## Dependencies

- **Uses**: `@modelcontextprotocol/sdk` (`McpServer`, `StreamableHTTPServerTransport`), `@slack/web-api`, `zod`, session/worktree/action/memory/pipeline stores
- **Used by**: spawned Claude/OpenCode/Codex instances (HTTP), `src/index.ts` (startup)
