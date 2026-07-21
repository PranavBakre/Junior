# WhatsApp Message Archive + Read Tools

## Problem

Junior needs on-demand access to WhatsApp group conversations — "what did they
say about X", "catch me up on that group" — without any automation hanging off
incoming messages. The original Hermes buildathon task tracker (Baileys →
`claude -p` extraction sweep → Notion sync) solved a one-off event workflow;
the event ended and that pipeline was removed. What remains is the useful core:
a passive, searchable archive of group messages.

## Solution

Two pieces:

1. **Ingestion (`src/whatsapp/`)** — a Baileys socket runs inside Junior's
   process (behind `WHATSAPP_ENABLED`) and appends group messages, backfill and
   live, into `wa_messages` in SQLite (`data/whatsapp.db`). Nothing is
   triggered off incoming messages; ingestion only writes the archive. There is
   no send path.
2. **Read tools (`src/mcp/whatsapp-tools.ts`)** — three tools on the shared
   slack-bot MCP server are the only read surface:
   - `whatsapp_list_groups` — groups with stored messages, counts, activity window
   - `whatsapp_read_messages` — newest window by group/time range, `before_ts` pages backwards
   - `whatsapp_search_messages` — case-insensitive substring search, optional group/sender scope

Notion integration is the plain hosted Notion MCP (`https://mcp.notion.com/mcp`
in `.mcp.json`) — no custom sync code.

### Data flow

```
Baileys socket (backfill + live batches)
    | ready-gate (buffers until group-subject map is fresh)
    v
ingestMessages -> WhatsAppStore.upsertMessage (INSERT OR IGNORE, append-only)
    v
wa_messages (SQLite, WAL)
    ^
    | on demand only
whatsapp_* MCP tools  <-  agents (via slack-bot MCP server)
```

### Key design points

- **Passive archive.** No extraction sweep, no timers, no per-message
  reactions. The store is read only when an agent calls a tool.
- **Ready gate.** Backfill batches can arrive before the group-subject map is
  populated; `createReadyGate` buffers them until `connection: open` confirms a
  fresh `groupFetchAllParticipating()`, and re-arms on every reconnect.
- **Group filter is optional.** `WHATSAPP_GROUP_PATTERN` unset (the default)
  ingests every group the account is in; set it to a case-insensitive regex to
  restrict. Messages from groups whose subject can't be resolved are skipped
  either way (the filter would be unenforceable, and `group_name` would be
  null).
- **Group resolution in tools.** `group` args accept an exact JID or a subject
  substring; ambiguous substrings return the candidate list instead of picking
  one.
- **Legacy schema leftovers.** Databases created by the retired extraction
  pipeline carry a `processed` column and a `wa_tasks` table. The store never
  touches them; they are harmless.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `WHATSAPP_ENABLED` | `false` | Master switch for the subsystem |
| `WHATSAPP_DB_PATH` | `data/whatsapp.db` | SQLite message archive |
| `WHATSAPP_AUTH_DIR` | `data/whatsapp-auth` | Baileys multi-file auth state |
| `WHATSAPP_GROUP_PATTERN` | unset | Optional case-insensitive regex over group subjects; unset = all groups |

Pairing: `bun run src/whatsapp/pair.ts` renders the QR, waits for the link,
prints the visible groups, and exits. Auth state persists in
`WHATSAPP_AUTH_DIR`; the running subsystem reuses it.

## Files

| File | Role |
|---|---|
| `src/whatsapp/client.ts` | Baileys socket lifecycle: QR, reconnect backoff, group-map refresh gate |
| `src/whatsapp/ingest.ts` | Pure event→store glue (`toWaMessage`, `ingestMessages`) + `createReadyGate` |
| `src/whatsapp/store.ts` | `WhatsAppStore` (bun:sqlite WAL): upsert, `listGroups`, `getMessages`, `searchMessages` |
| `src/whatsapp/index.ts` | `startWhatsApp(config)` wiring; returns handle `{ store, resolveGroupName, stop }` |
| `src/whatsapp/pair.ts` | One-shot pairing CLI |
| `src/whatsapp/types.ts` | Message/query/config types |
| `src/mcp/whatsapp-tools.ts` | MCP tool registration + `setWhatsAppHandle` |

## History

The Hermes buildathon tracker this replaced (LLM task extraction, task tables,
custom Notion database sync, mentor-links script) shipped in PR #121/#122 and
was removed after the event. Its design is historical and is not part of the
current documentation tree. A possible future direction from that era —
reply-in-group as Pranav — remains unbuilt and gated on his explicit approval.
