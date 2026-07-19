# Bot Slack MCP Server

## Problem

Spawned Claude Code processes need Slack access — to send messages, read channels, search conversations, and upload files. The official Slack plugin (`slack@claude-plugins-official`) provides this, but it sends messages as the user's personal OAuth identity (no `bot_id`). Junior's event handler filters by `bot_id` to prevent loops, so plugin messages bypass the filter and trigger an infinite loop: Claude posts via plugin → Junior picks it up as a new user message → spawns Claude again → repeat.

**Who has this problem:** Any spawned Claude instance that needs to interact with Slack.
**What happens today:** Slack plugin enabled → messages come from Pranav's account → Junior sees them as new events → infinite loop.
**Painful part:** The identity model. The plugin authenticates as the user, not the bot. There's no way to configure it to use the bot token.
**"Finally" moment:** Claude sends messages that appear as Junior (the bot), event handler skips them, no loop.

## Solution

A shared HTTP MCP server running inside Junior's main process. It uses the bot token (`SLACK_BOT_TOKEN`) so all messages carry Junior's `bot_id`. The event handler at `src/slack/events.ts:31` already filters by `selfBotId` — messages from the bot MCP server are automatically ignored.

### Why shared, not per-instance

Each spawned Claude process connects to the same MCP server via HTTP. Alternatives considered:

| Approach | Problem |
|---|---|
| stdio MCP server in `.mcp.json` | Spawns a new process per Claude instance. N concurrent threads = N processes with N WebClient connections. Wasteful. |
| Slack plugin with better filtering | Plugin authenticates as the user. Can't change the identity model. |
| No MCP, bash scripts only | `slack-upload.sh` works for uploads, but no send/read/search. Claude can't proactively message. |
| HTTP MCP server (chosen) | One process, one WebClient, all instances connect via URL. Bot token = bot identity. |

### Architecture

```
Junior main process
  ├── Slack Bolt app (Socket Mode, port N/A)
  ├── MCP HTTP server (port 3456)
  │     └── StreamableHTTPServerTransport (stateless)
  │           └── WebClient(SLACK_BOT_TOKEN)
  │
  └── Spawned Claude instances (concurrent)
        ├── Claude A ──► http://localhost:3456/mcp
        ├── Claude B ──► http://localhost:3456/mcp
        └── Claude C ──► http://localhost:3456/mcp
```

### Tools

| Tool | Slack API | Purpose |
|---|---|---|
| `slack_send_message` | `chat.postMessage` | Send/reply in channels and threads as the bot |
| `slack_send_dm` | `conversations.open` + `chat.postMessage` | Open a DM by Slack user ID and send as the bot |
| `slack_read_channel` | `conversations.history` | Read recent channel messages |
| `slack_read_thread` | `conversations.replies` | Read thread replies |
| `slack_search` | `search.messages` | Search across channels (requires `search:read` scope) |
| `slack_search_users` | `users.list` | Find users by name, email, or title |
| `slack_upload_file` | `files.getUploadURLExternal` | Upload files to channels/threads |
| `register_worktree` | (internal) | Create a per-thread worktree in a routed repo and persist its path on the session |
| `agent_search` | (internal) | Search public/private agent definitions and show dispatch registration state |
| `reload_agent_registry` | (internal) | Reload private overlay agent identities so newly added workers become dispatchable |
| `memory_recall` | (internal SQLite + profiles) | Recall v3 memory: keyed entity profiles (by `entity_refs`) + semantic claims (query embedded locally, cosine-ranked) |
| `memory_add` | (internal SQLite) | Add and locally embed one atomic claim (lesson/fact/situation-claim) into the semantic store |
| `memory_consolidate` | (internal SQLite + LLM) | Run the v3 offline consolidation sweep: read unconsolidated source records, derive episodes/profiles/claims via the runner LLM |
| `whatsapp_list_groups` | (internal SQLite) | List WhatsApp groups with stored messages (name, JID, counts, activity window) |
| `whatsapp_read_messages` | (internal SQLite) | Read stored WhatsApp messages by group/time window, paged backwards with `before_ts` |
| `whatsapp_search_messages` | (internal SQLite) | Case-insensitive text search over stored WhatsApp messages, optionally by group/sender |

Slack tools require explicit `channel_id` and `thread_ts` parameters. The spawned Claude already knows its thread coordinates from the prompt preamble built by `buildPromptPreamble()`.

`register_worktree` is wired to Junior's `SessionStore` and `WorktreeManager` (passed into `startMcpServer`). It's invoked by agents during intake — once per routed repo — and writes `session.worktreePaths[repo]`. The `branch` arg is a branch-name override (not a base ref); `createWorktree` keeps `branchOverride` distinct from `baseRef` so callers can name the branch without changing what it forks from. See [worktree-manager.md](./worktree-manager.md) and [session-management.md](./session-management.md).

Status pill updates that agents post mid-run go through `slack_send_message` with a stable `username` / `icon_emoji` identity — the streaming layer keys pills per-agent off those fields. See [stream-to-slack.md](./stream-to-slack.md).

## Dependencies

- MCP SDK (`@modelcontextprotocol/sdk`) — provides `McpServer` and `StreamableHTTPServerTransport`
- Slack Web API (`@slack/web-api`) — transitive dependency from `@slack/bolt`
- Bot token with scopes: `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`, `users:read.email`, `files:write`, `search:read` (optional)

## Configuration

- `.mcp.json` defines the server as `{ "type": "http", "url": "http://localhost:3456/mcp" }`
- `.claude/settings.json` grants `mcp__slack-bot__*` permissions
- Port configurable via `MCP_PORT` env var (default 3456)
- `--mcp-config` flag injected by `spawner.ts` when cwd differs from project root (worktree scenarios)
- OpenCode receives the same `slack-bot` MCP through generated
  `OPENCODE_CONFIG_CONTENT` for all normal runs, including initial lead intake
  from Junior's project root. Explicit `session.cwd` utility runs still skip
  Junior's local MCP wiring.
- The Mixpanel MCP is intentionally **not** in `.mcp.json` and is not part of
  default Junior's OpenCode config. It is injected only when the active
  OpenCode session is `feature-metrics`, using Mixpanel's official hosted MCP
  through `npx -y mcp-remote https://mcp.mixpanel.com/mcp`. Disable with
  `OPENCODE_MIXPANEL_MCP_ENABLED=false`.
- MongoDB MCP uses `MDB_MCP_CONNECTION_STRING` from the process environment.
  `.env.example` includes a placeholder; real values belong only in local
  `.env` or secret managers. Junior exposes a shared read-only HTTP proxy at
  `/mcp/mongodb`, backed by one wrapped `mongodb-mcp-server@latest --readOnly`
  stdio child. Runner adapters inject that proxy only when the active agent
  declares `permissions.mcp: mongodb` or lists `mcp__mongodb__*` tools.
  Disable with `OPENCODE_MONGODB_MCP_ENABLED=false` /
  `CODEX_MONGODB_MCP_ENABLED=false`.

### Agent registry tools

`agent_search` reads `.claude/agents/*.md` and `agents-org/*.md`, then reports
which definitions currently have a registered Slack identity and are therefore
dispatchable via `!<agent>`.

`reload_agent_registry` reruns the private overlay identity loader for
`agents-org`. This fixes the common case where a new private agent file was
pulled onto disk but the running process has not registered its `username` /
`iconEmoji` yet. Agent prompts themselves are read from disk on each resolve;
the registry reload is for persistent-agent identity/dispatch metadata.

### WhatsApp tools

The `whatsapp_*` tools (`src/mcp/whatsapp-tools.ts`) are the only read surface
over the WhatsApp message archive (see [whatsapp-tools.md](whatsapp-tools.md)).
The subsystem starts after `startMcpServer` in the async bootstrap, so the
handle arrives via `setWhatsAppHandle`; until then (or when `WHATSAPP_ENABLED`
is off) the tools answer with a plain "not enabled" message. `group` arguments
accept either an exact JID or a case-insensitive subject substring — ambiguous
substrings return the candidate list instead of guessing.

The archive is the operator's personal WhatsApp history, so Slack-initiated
turns are gated: the destination must be a DM (`D…` channel — channel-thread
replies are visible to every channel member, so no poster-based check is sound
there), and every human participant of the session — resolved live from the
session store at each tool call, never from a spawn-time snapshot — must pass
the admin check (`ADMIN_SLACK_USER_ID` + admins table). Unknown sessions deny.
Direct local connections (bare `.mcp.json` URL, no run-context params) are
allowed: the listener is loopback-only, so that caller already has local
machine access.

### Memory tools

`memory_recall`, `memory_add`, and `memory_consolidate` expose Junior's v3 memory
(see [memory-system-v3.md](memory-system-v3.md)) to normal runner sessions through
MCP. They open the SQLite memory database from `MEMORY_DB_PATH` or `data/memory.db`,
perform the requested operation, and close the store after each call. The local
embedding model (harrier-270 ONNX) is lazy-loaded on the first recall/add, never at
server startup.

- `memory_recall` accepts `query`, `repo`, `kinds`, `entity_refs`, and `limit`. It
  fetches the keyed entity profiles verbatim by `entity_ref` (no vector) and embeds
  `query` locally to cosine-rank the atomic claim store; returns the profiles plus
  the top-k claims. Recall is cosine-only — there is no FTS channel.
- `memory_add` accepts `text`, `kind`, `repo`, and `tags`, embeds the text locally
  (document mode), and stores one atomic claim with its embedding co-located.
- `memory_consolidate` takes no inputs. It drains all unconsolidated source records
  (session-scoped per thread, then a final unthreaded sweep), asks the runner LLM
  for derivations, and persists episodes/profiles/claims through the v3 gates.

Workflow utility runs use an explicit utility cwd, which skips Junior's project
MCP wiring by design. Those runs access the store through the v3 CLI
(`src/memory/cli.ts`): `consolidate-v3`, `recall-claims`, `add-claim`, `add-lesson`,
and `add-fact`.

## What it replaced

- `slack@claude-plugins-official` in `.claude/settings.json` — removed entirely
- `bin/slack-upload.sh` — superseded by `slack_upload_file` tool (script still exists for backward compat)

## Iterations

### Iteration 0: Core server with send/read tools (done)

**What it adds:** HTTP MCP server started in `index.ts`, 6 Slack tools registered, `.mcp.json` and settings updated, `--mcp-config` wired for worktree spawns.
**Test:** Start Junior, spawned Claude can send a message that appears as the bot. No event loop.

### Iteration 0.1: register_worktree tool (done)

**What it adds:** `register_worktree` tool so agents can request a per-thread worktree without shelling out. `startMcpServer` now takes `SessionStore` and `WorktreeManager` so the tool can persist `worktreePaths` on the session.
**Test:** An agent calls `register_worktree` on intake; subsequent spawns in that thread use the persisted worktree path as cwd.

### Iteration 1: Thread-aware defaults (future)

**What it adds:** Tools accept optional `channel_id`/`thread_ts` that fall back to the prompt context. Claude doesn't have to specify thread coordinates on every call — reduces token usage.
**Defers:** Requires passing thread info to the MCP server per-request (e.g., via headers or session).

### Iteration 2: Rate limit awareness (future)

**What it adds:** Surface Slack rate limit headers back to Claude as tool result metadata. Let Claude back off intelligently instead of hitting 429s.

## Cut List (true v2)

- MCP server authentication (currently open on localhost — fine for single-machine deployment)
- Canvas/bookmark tools (low priority, not used in current workflows)
- Scheduled message tools (use Slack's built-in scheduling instead)
- Reactions tool (Claude can use the bash tool + curl as a workaround)
