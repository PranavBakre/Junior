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
| `handleMongoMcpRequest(req, res)` | `mongodb-proxy.ts` | Serves `/mcp/mongodb` as a stateless HTTP MCP proxy to one shared read-only MongoDB stdio backend; hides upstream connection selection, injects the environment-backed `preconfigured` ID, and requires explicit `find.limit` values from 1–100. |
| `closeMongoMcpBackend()` | `mongodb-proxy.ts` | Closes the shared backend immediately; also used by the idle TTL. |
| `handleMixpanelMcpRequest(req, res)` | `mixpanel-proxy.ts` | Serves `/mcp/mixpanel` as one signed read-only MCP surface over all configured Mixpanel regions. |
| `createMixpanelProxyServer(...)` | `mixpanel-proxy.ts` | Unions safe upstream tools, adds the required `region` selector, strips it before forwarding, and rejects write tools. |
| `closeMixpanelMcpBackends()` | `mixpanel-proxy.ts` | Closes the shared per-region HTTP clients immediately; also used by the idle TTL. |
| `MixpanelOAuthProvider` | `mixpanel-oauth.ts` | Persists region-isolated OAuth client registrations, PKCE verifiers, and refreshable tokens with restricted filesystem permissions. |
| `bun run mixpanel:oauth` | `mixpanel-oauth-cli.ts` | Opens and completes US, EU, and IN OAuth authorization sequentially through a validated loopback callback. |
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
| `agent_dispatch` | Junior internal | agent, prompt, thread context | repo refs; automatic repo-less isolation for Mongo-read agents with no repo, optional explicit `workspace_mode`; synthetic user/timestamp |
| `memory_recall` / `memory_add` / `memory_consolidate` | Memory v3 | tool-specific | filters/options; `fact_kinds` exposes procedure/routing/curated-fact subtypes |
| `runbook_select` | Runbooks + Memory v3 | `request` | Select reviewed runbook; on miss perform procedure-memory recall |
| `promotion_record` / `runbook_propose` | Runbook promotion + authoring | promotion evidence plus optional authoritative `request`; proposal `fingerprint` | Promotion retains normalized request intent (with legacy runbook-name fallback), so proposals produce usable names/descriptions and dry-run PR content. |
| `github_read_pr_review_state` / `github_post_review` | Fixed GitHub API surface | review-specific | inline comments |
| `pipeline_*` | Durable pipeline store | tool-specific | artifact/check fields |
| `whatsapp_*` | Read-only archive | tool-specific | time/group filters |

### Configuration

| File | What |
|---|---|
| `.mcp.json` | Root config contains only the local `slack-bot` server. Per-agent generated configs add Playwright, MongoDB, Mixpanel, and capability-gated hosted Figma/Notion servers as needed. |
| `.claude/settings.json` | `permissions.allow: ["mcp__slack-bot__*"]` |
| `src/claude/spawner.ts` | Passes `--mcp-config` for worktree spawns |
| `src/codex-app-server/spawner.ts` | Routes native approval callbacks through the shared Slack approval bridge |

## Key Concepts

### Stateless per request

Each HTTP request creates a fresh `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`). No MCP session state is kept between requests. Slack requests share the same `WebClient` (module-level singleton). MongoDB proxy requests share one lazily started wrapped stdio backend. Mixpanel proxy requests share one lazily started hosted-MCP client per configured region. Both proxy types close idle backends after a TTL. Run context is HMAC-signed per spawn and validated before thread/agent-sensitive tools execute.

### Identity model

Messages sent via `slack_send_message` carry Junior's `bot_id`. Optional `username` + `icon_emoji` per call let agents post under their own persona while the underlying identity stays junior's bot. The event handler (`events.ts`) filters by `selfBotId` to prevent loops — but messages with `!<persistent-agent>` directives are let through (see `slack-event-handler.md`).

### `register_worktree` tool

Called by lead/intake to create a per-thread worktree for a repo and persist its path into `session.worktreePaths[repoName]`. Multi-repo bug-pipeline support — `worktreePaths` keys are repo names from `REPOS` config. Refetch-then-mutate guards against concurrent session writes.

### Agent registry tools

`agent_search` scans `.claude/agents` and `agents-org` from disk and annotates each result with whether `AGENT_IDENTITIES` currently makes it dispatchable. `reload_agent_registry` reruns `loadOverlayIdentities("agents-org")`, which lets newly added private workers become dispatchable without a full process restart. Existing identities are not overwritten; prompts are already resolved from disk per turn.

### Promotion intent continuity

`promotion_record` accepts an authoritative operator request either at the
top level or inside the evidence object. It normalizes that request before
creating/updating the in-memory promotion candidate; legacy evidence without a
request falls back to its runbook name and is marked non-authoritative. A later
authoritative request replaces that fallback for the same fingerprint.
`runbook_propose` consumes the same
candidate and therefore receives a non-empty `normalizedIntent` for filename,
description, routing examples, and proposal content. The evidence schema keeps
`request` optional for backward compatibility.

## Dependencies

- **Uses**: `@modelcontextprotocol/sdk` (`McpServer`, `StreamableHTTPServerTransport`), `@slack/web-api`, `zod`, session/worktree/action/memory/pipeline stores
- **Used by**: spawned Claude/OpenCode/Codex instances (HTTP), `src/index.ts` (startup)
