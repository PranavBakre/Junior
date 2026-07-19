# Code Index — whatsapp-tools

Feature doc: [../features/whatsapp-tools.md](../features/whatsapp-tools.md)

## src/whatsapp/

| File | Key exports | Notes |
|---|---|---|
| `client.ts` | `WhatsAppClient`, `MessageSource` | Baileys socket lifecycle: QR callback, backoff reconnect (halts on `loggedOut`), group-map refresh gate — `onOpen` fires only after a successful `groupFetchAllParticipating()` |
| `ingest.ts` | `ingestMessages`, `toWaMessage`, `createReadyGate`, `IngestDeps`, `ReadyGate` | Pure event→store glue. Skips DMs, unknown-subject groups, textless messages; `groupPattern: RegExp \| null` (null = all groups). Ready-gate buffers batches until the group map is fresh, re-arms on reconnect |
| `store.ts` | `WhatsAppStore` | bun:sqlite WAL, append-only `wa_messages` (INSERT OR IGNORE). Reads: `getMessage`, `listGroups` (newest-activity first, newest non-null subject wins), `getMessages` (newest window, chronological order, `beforeTs` pages back), `searchMessages` (escaped LIKE, newest first) |
| `index.ts` | `startWhatsApp`, `WhatsAppHandle` | Wires store+client+ingest through the ready-gate; handle = `{ store, resolveGroupName, stop }` |
| `pair.ts` | (CLI) | `bun run src/whatsapp/pair.ts` — QR pairing, prints visible groups |
| `types.ts` | `WaMessage`, `WaMessageInput`, `WaGroupSummary`, `WaMessageQuery`, `WaSearchQuery`, `WhatsAppConfig` | |

## src/mcp/whatsapp-tools.ts

`registerWhatsAppTools(server)` registers `whatsapp_list_groups`,
`whatsapp_read_messages`, `whatsapp_search_messages` on the slack-bot MCP
server (called from `registerTools` in `slack-server.ts`). `setWhatsAppHandle`
injects the live handle from the async bootstrap in `src/index.ts`; tools
answer "not enabled" until it's set. `resolveGroup` accepts an exact JID or a
subject substring and refuses ambiguous matches.

## Data flow

Baileys batches → ready-gate → `ingestMessages` → `wa_messages` (SQLite).
Read-only, on-demand via the MCP tools; no automation triggers off messages.

## Config

`WHATSAPP_ENABLED` (default false), `WHATSAPP_DB_PATH`, `WHATSAPP_AUTH_DIR`,
`WHATSAPP_GROUP_PATTERN` (unset = all groups). Parsed in `src/config.ts`
(`Config["whatsapp"]`, optional for test fixtures).
