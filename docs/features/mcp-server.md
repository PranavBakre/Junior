# Bot Slack MCP Server

> **Current status (2026-07-21):** Shipped. This server is the shared loopback MCP surface for Claude, OpenCode, and Codex runs. The code-index page is the compact current inventory; this feature page retains the design history and security rationale.

## Problem

Spawned Claude Code processes need Slack access — to send messages, read channels, search conversations, and upload files. The official Slack plugin (`slack@claude-plugins-official`) provides this, but it sends messages as the user's personal OAuth identity (no `bot_id`). Junior's event handler filters by `bot_id` to prevent loops, so plugin messages bypass the filter and trigger an infinite loop: Claude posts via plugin → Junior picks it up as a new user message → spawns Claude again → repeat.

**Who has this problem:** Any spawned Claude instance that needs to interact with Slack.
**What happens today:** The bot-owned MCP path posts with Junior's bot identity, while ordinary self-authored bot events are filtered. Explicit persistent-agent directives and configured auto-trigger exceptions still pass through the event router by design.
**Painful part:** The identity model. The plugin authenticates as the user, not the bot. There's no way to configure it to use the bot token.
**"Finally" moment:** Claude sends messages that appear as Junior (the bot), event handler skips them, no loop.

## Solution

A shared HTTP MCP server running inside Junior's main process. It uses the bot token (`SLACK_BOT_TOKEN`) so messages carry Junior's `bot_id`. The event handler filters ordinary self-authored bot traffic; explicit directives and configured auto-trigger channels are handled as intentional exceptions.

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
| `memory_feedback` | (internal SQLite) | Record an agent's explicit useful/useless judgment for recalled claim ids; increments `helpful_count` or `unhelpful_count` |
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

- `.mcp.json` documents only the local `slack-bot` endpoint. Claude receives a generated per-session MCP config under `data/mcp-configs/`; OpenCode and Codex receive equivalent generated provider config. All normal worktree and Junior-root runs get the local Slack MCP; explicit utility `session.cwd` runs do not. Hosted Figma/Notion OAuth servers are emitted only for agents whose `wantsMcp` capability includes the requested server.
- `.claude/settings.json` grants `mcp__slack-bot__*` permissions
- Port configurable via `MCP_PORT` env var (default 3456)
- `--mcp-config` flag injected by `spawner.ts` for every non-utility Claude run (not only when cwd differs from project root)
- OpenCode receives the same `slack-bot` MCP through generated
  `OPENCODE_CONFIG_CONTENT` for all normal runs, including initial lead intake
  from Junior's project root. Explicit `session.cwd` utility runs still skip
  Junior's local MCP wiring.
- The Mixpanel MCP is intentionally **not** in `.mcp.json` and is injected only
  for `feature-metrics` sessions. Junior exposes one signed, read-only HTTP MCP
  at `/mcp/mixpanel`; it maintains one upstream connection for each configured
  Mixpanel data-residency region (US, EU, and/or IN), combines their safe tool
  schemas, and adds a required `region` argument to every tool. Configure
  `bun run mixpanel:oauth` performs the three independent regional OAuth flows
  sequentially and persists each client registration, access token, refresh
  token, and PKCE state under mode-0700 `data/mixpanel-oauth` with mode-0600
  files. The runtime refreshes each grant independently. Optional
  `MIXPANEL_MCP_US_TOKEN`, `MIXPANEL_MCP_EU_TOKEN`, and
  `MIXPANEL_MCP_IN_TOKEN` service-account credentials take precedence per
  region. User OAuth cannot combine multiple regional authorization servers
  into one grant, so initial setup still requires one approval per region.
  Interrupted setup is resumable, and specific regions can be retried with
  `bun run mixpanel:oauth -- eu in`.
  New upstream tools fail closed until
  explicitly classified as read-only. Disable runner injection with
  `OPENCODE_MIXPANEL_MCP_ENABLED=false` /
  `CODEX_MIXPANEL_MCP_ENABLED=false`.
- Human-gated Codex app-server commands use the same blocking Slack Allow/Deny
  actions and pending-approval registry as Claude's permission prompt tool.
  The registry entry exists before a prompt can become actionable, preventing
  immediate clicks from racing resolver setup. Exact app-server callback
  methods retain their native response contracts (`decision` for command/file,
  requested `permissions` for permissions). Missing Slack context,
  delivery/storage errors, expiry, or handler failure defaults to denial and
  resolver cleanup. Codex process exit and explicit stop also cancel the
  approval, disable its stored actions, and remove its buttons; a delayed Slack
  decision cannot outlive the provider process that requested it. An ordinary
  approval timeout/default deny performs the same idempotent cleanup.
- MongoDB MCP uses named read-only connections from `MDB_MCP_CONNECTIONS`, a
  JSON object mapping stable IDs such as `dev` and `prod` to connection
  strings. `.env.example` includes a placeholder; real values belong only in
  local `.env` or secret managers. Junior exposes a shared read-only HTTP
  proxy at `/mcp/mongodb`, backed by one wrapped
  `mongodb-mcp-server@2.1.0 --readOnly` stdio child per configured target.
  The proxy unions the safe tool schemas and adds a required `connection`
  selector, then injects the upstream `preconfigured` ID into the selected
  backend. Agents cannot supply raw connection strings or select arbitrary
  upstream IDs. The legacy `MDB_MCP_CONNECTION_STRING` remains supported as a
  single `preconfigured` target. Runner adapters inject that proxy only when
  the active agent declares `permissions.mcp: mongodb` or lists
  `mcp__mongodb__*` tools.
  Disable with `OPENCODE_MONGODB_MCP_ENABLED=false` /
  `CODEX_MONGODB_MCP_ENABLED=false`.
  The proxy requires every `find` call to provide an explicit integer
  `limit` from 1 through 100 and rejects unbounded/over-cap requests before
  contacting MongoDB. This makes capped results explicit rather than silently
  presenting a partial dataset; complete exports must use a separately
  approved schema-preserving export workflow.

### Agent registry tools

`agent_search` reads `.claude/agents/*.md` and `agents-org/*.md`, then reports
which definitions currently have a registered Slack identity and are therefore
dispatchable via `!<agent>`.

`reload_agent_registry` reruns the private overlay identity loader for
`agents-org`. This fixes the common case where a new private agent file was
pulled onto disk but the running process has not registered its `username` /
`iconEmoji` yet. Agent prompts themselves are read from disk on each resolve;
the registry reload is for persistent-agent identity/dispatch metadata.

`agent_dispatch` accepts `repo_refs` for worktree-backed successors. The refs
are validated against configured repositories and bound to the run in the same
transaction that creates the successor assignment. Dispatch fails before
mutation when a worktree-backed target has no effective repository. A
human-input recovery assignment can retry an escalated run with corrected
`repo_refs`; default runs resume to `working`, while typed runs require an
explicit legal `to_phase`.

For a bounded MongoDB read, a target with the `mongodb-read` capability is
automatically dispatched repo-less when the run and dispatch contain no
repository refs and `workspace_mode` is omitted. The caller may also request
`workspace_mode: "repo-less"` explicitly. That assignment receives only the
MongoDB capability envelope, an empty mutation scope, and no target-repo
worktree. Explicit `workspace_mode: "managed"`, or any bound/requested
repository ref, preserves managed worktree behavior for code and migrations.

### WhatsApp tools

The `whatsapp_*` tools (`src/mcp/whatsapp-tools.ts`) are the only read surface
over the WhatsApp message archive (see [whatsapp-tools.md](whatsapp-tools.md)).
The subsystem starts after `startMcpServer` in the async bootstrap, so the
handle arrives via `setWhatsAppHandle`; until then (or when `WHATSAPP_ENABLED`
is off) the tools answer with a plain "not enabled" message. `group` arguments
accept either an exact JID or a case-insensitive subject substring — ambiguous
substrings return the candidate list instead of guessing.

The archive is the operator's personal WhatsApp history, so access is gated:
a run context is required (the bare loopback URL with no query params is
callable by any local process — including agents spawned for non-admin turns —
so it denies), the session's STORED channel must be a DM (`D…` — the
query-param channel is caller-controlled and ignored; channel-thread replies
are visible to every channel member, so no poster-based check is sound there),
and every human participant of the session — resolved live from the session
store at each tool call, never from a spawn-time snapshot — must pass the
explicit admin check (`ADMIN_SLACK_USER_ID` + admins table; the local-dev
open-admin fallback never unlocks the archive). Unknown sessions deny. All
message-bearing responses (including group subjects) are wrapped in an
UNTRUSTED-content boundary before entering a tool-capable agent's context.

The run context is HMAC-signed per spawn, so callers cannot substitute a
different channel or thread in the MCP query context. Note the honest ceiling:
agents with unrestricted Bash on this
machine can read `data/whatsapp.db` directly, so the MCP gate can never exceed
filesystem-level protection — restricting which agents get Bash (or moving the
archive off-box) is the stronger lever.

### Slack archive tools

`slack_archive_search` and `slack_archive_thread` read the separate passive
Slack archive described in [slack-archive.md](slack-archive.md). They do not
read `memory_source_record` and archive rows never enter consolidation or
automatic pre-recall. Search is lexical by default, accepts exact metadata/time
filters, and can expand hits to bounded chronological threads.

Its MCP surface requires a signed runner context and authorizes the session's
stored channel using server-side state. Public Slack channels are allowed;
non-public channels must appear in `SLACK_ARCHIVE_APPROVED_CHANNEL_IDS`. The
caller-controlled context channel is never trusted. All returned Slack content
is marked untrusted and carries channel/thread/timestamp source coordinates.

### Memory tools

`memory_recall`, `memory_add`, and `memory_consolidate` expose Junior's v3 memory
(see [memory-system-v3.md](memory-system-v3.md)) to normal runner sessions through
MCP. They open the SQLite memory database from `MEMORY_DB_PATH` or `data/memory.db`,
perform the requested operation, and close the store after each call. The local
embedding model (harrier-270 ONNX) is lazy-loaded on the first recall/add, never at
server startup.

- `memory_recall` accepts `query`, `repo`, `tags` (`tag_match` selects OR/AND), `kinds`,
  `fact_kinds`, `entity_refs`, and `limit`. It
  fetches the keyed entity profiles verbatim by `entity_ref` (no vector) and embeds
  `query` locally to hybrid-rank the atomic claim store; returns the profiles plus
  the top-k claims. Returned facts retain `factKind`, so procedures are filterable
  and identifiable end to end. `guidance_only` scopes candidates to lessons,
  preferences, decisions, and typed procedures before ranking.
- `memory_add` accepts `text`, `kind`, `repo`, and `tags`, embeds the text locally
  (document mode), and stores one atomic claim with its embedding co-located. The
  store's write guard collapses semantic near-duplicates, so the result carries an
  `action` — `inserted`, `updated`, or `merged` (with `mergedInto`) — letting the
  caller tell "stored" from "already knew that". See
  [claim-dedup-write-guard.md](claim-dedup-write-guard.md).
- `memory_consolidate` takes no inputs. It drains all unconsolidated source records
  (session-scoped per thread, then a final unthreaded sweep), asks the runner LLM
  for derivations, and persists episodes/profiles/claims through the v3 gates.

Workflow utility runs use an explicit utility cwd, which skips Junior's project
MCP wiring by design. Those runs access the store through the v3 CLI
(`src/memory/cli.ts`): `consolidate-v3`, `recall-claims`, `add-claim`, `add-lesson`,
`add-fact`, and `dedup-sweep`.

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

- Network transport authentication (the HTTP listeners remain loopback-only; sensitive tools require a signed per-spawn run context, but a local process with filesystem access can still reach the endpoint)
- Canvas/bookmark tools (low priority, not used in current workflows)
- Scheduled message tools (use Slack's built-in scheduling instead)
- Reactions tool (Claude can use the bash tool + curl as a workaround)
