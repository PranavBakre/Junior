# WhatsApp Hermes Buildathon Task Tracker — Approach (PROPOSAL, awaiting approval)

## Goal

Track tasks across the Hermes buildathon WhatsApp groups and keep a live tasklist in Notion:

1. Read all Hermes buildathon WhatsApp groups (history + new messages).
2. Infer tasks from messages (LLM extraction) with at minimum: **task, owner, priority (p0/p1/p2), status, notes**.
3. Replies from people mark tasks completed / update status.
4. Sync the tasklist to the Notion page: `growthxclub/Hermes-Buildathon-tasks` (page ID `39a3578dc3f08015b386cc6638029bed`).
5. Add `hermes-scoring/mentor-links.csv` (37 rows: City, Name, Role, Token, Link) as a sub-page of that Notion page.
6. When someone in a group asks Pranav what they should do next, reply with their tasks ordered by priority.

## Decision 1 — WhatsApp connectivity: Baileys (recommended) vs lharries/whatsapp-mcp

| | **Baileys** (recommended) | lharries/whatsapp-mcp |
|---|---|---|
| What it is | TypeScript library, WhatsApp Web multi-device over WebSocket. v7 released May 2026, actively maintained, explicit Bun support | Go bridge (whatsmeow) + Python MCP server + SQLite message store |
| Stack fit | Native to junior (Bun/TS). Imports as a library into a `src/whatsapp/` module | Two foreign runtimes (Go + Python/UV) to install, run, and babysit alongside junior |
| Message flow | **Event-driven**: live message events pushed over the socket. Enables instant "what's next" replies and reply-marks-done detection | Pull-based: bridge writes SQLite, MCP tools are designed for interactive Claude Desktop use. We'd poll the SQLite DB on a cron — reply latency = poll interval |
| History backfill | Multi-device history sync on pairing (recent history; we only need buildathon-era messages) | Full history sync built in (its main convenience) |
| Sending | Yes, same socket | Yes, via bridge REST API |
| Build cost | Higher: we own pairing/auth-state, reconnect handling, and the message store (~1 module) | Lower to stand up, but the MCP layer gives us little — our pipeline is automated, not interactive |
| Known pain | ToS gray area (same for both) | ~20-day re-auth cycle reported; known desync issue whose fix is "delete the DB and re-pair" |

**Recommendation: Baileys**, integrated as a junior module. The MCP part of lharries' project is the piece we'd use least — our consumer is an automated pipeline, not a human driving Claude Desktop. What we actually need (socket + auth state + message events) is exactly what Baileys provides natively in our stack, and event-driven delivery is what makes the "reply when asked" requirement work without polling lag. We'd still expose WhatsApp read tools over junior's existing MCP server (`src/mcp/`) so Slack-side sessions can query the tasklist — MCP as *our* interface, not a dependency.

**Fallback** if the Baileys pairing spike fails (Phase 0): adopt lharries' Go bridge only (skip its Python MCP), read its SQLite from junior, send via its REST API.

## Decision 2 — Where it lives: junior module (recommended) vs standalone service

**Recommended: inside junior** as a new channel module `src/whatsapp/`, on its own branch off `main`.

- Junior is already a long-lived process (Slack Socket Mode + `setInterval` jobs in `src/index.ts`) — a persistent WhatsApp socket and a periodic extraction sweep slot straight in.
- Reuses existing infrastructure: SQLite patterns (`bun:sqlite`), the `claude -p` runner used by memory consolidation, config/env loading, the HTTP dashboard, graceful shutdown.
- Pranav can ask Junior about the tasklist from Slack too, not just WhatsApp.

Standalone `hermes-tracker` service is the alternative (buildathon is time-boxed; isolates ban risk from junior's process). Costs: duplicated runner/config/store plumbing and a second daemon to operate. Not worth it unless we want hard isolation.

## Architecture

```
WhatsApp (Hermes groups)
    |  Baileys socket (QR-paired linked device, auth state on disk)
    v
src/whatsapp/client.ts        -- socket lifecycle, reconnect, pairing
src/whatsapp/store.ts         -- SQLite: raw messages (append-only) + tasks table
    |                            groups filtered by name allowlist ("Hermes*")
    +-- live trigger: message addressed to Pranav asking "what next"
    |       -> query tasks by owner, order p0>p1>p2, send reply to group
    |
    +-- extraction sweep (setInterval, ~10 min):
            new messages since cursor
                -> claude -p with extraction prompt + current open tasklist
                -> task upserts (new / status change / completion via reply)
                -> write SQLite (source of truth)
                -> diff-sync to Notion database
```

- **SQLite is the source of truth**; Notion is a synced view. Avoids two-way merge problems — manual Notion edits are out of scope for v1 (flagged below).
- **Notion sync** via direct REST API (`@notionhq/client` or ~100-line fetch wrapper — per critical rule 14, no MCP dependency for a headless server). A database is created on the Hermes page with columns: Task (title), Owner (select), Priority (select: p0/p1/p2), Status (select: open/in-progress/done/blocked), Notes (rich text), Source (group + message link/date). Each task row carries the Notion page ID back in SQLite for updates.
- **mentor-links.csv** → one-shot script creating a sub-page with a 37-row table. Run once, done.
- **Extraction prompt** receives: new messages (with sender, group, reply-to context) + current open tasks for those groups. Returns structured JSON: `create | update_status | complete | note` operations. Feeding the open tasklist in makes completion-matching and dedupe the LLM's job instead of a fuzzy-match heuristic.

## The reply flow — identity guardrails

Pairing a linked device means **replies send from Pranav's personal account, as Pranav**. The ask ("if someone asks you (me)… reply back") sanctions this, but it collides with the standing "no proxy messages" rule from Slack, so v1 ships with a closed allow-list, mirroring the lead-agent posting policy:

- Reply **only** to messages that directly ask what to do next / task status (explicit intent match, not vague inference).
- Reply is templated from the tasklist (deterministic content, LLM only classifies the ask) and prefixed, e.g. `🤖 tasklist:` so it's visibly automated.
- Everything else: never send. No proactive nudges, no confirmations, no announcements in v1.
- Kill switch: env flag `WHATSAPP_REPLIES_ENABLED=false` disables sending entirely (read-only mode) — this is also the Phase 1–2 default until explicitly enabled.

## Risks

1. **Account ban (ToS).** Both options are unofficial clients; WhatsApp can ban the paired account — and this pairs **Pranav's personal number**. Read-mostly usage with low-volume human-paced replies is the low-risk profile, but the risk is not zero. Mitigation option: a spare number/eSIM added to the groups instead. **Needs your call.**
2. **History depth.** Baileys history sync on pairing returns recent history, not necessarily the full group backlog. If the buildathon groups predate pairing by a lot, earliest messages may be missing (lharries bridge has the same practical limits). Mitigation: pair ASAP; extraction works forward from whatever backfill lands.
3. **Re-auth.** Linked devices can get logged out (~20-day reports). Detection → dashboard alert + Slack DM to Pranav to re-scan QR.
4. **One-way sync.** Manual edits in Notion get overwritten on the next diff-sync of that row. v1 keeps SQLite authoritative; if you want to edit in Notion, say so and we make status Notion-wins.

## Prerequisites (Pranav)

1. **Notion integration token**: create an internal integration in the growthxclub workspace, share the Hermes page with it, drop the token in junior's `.env` (`NOTION_TOKEN`). Never inline in prompts/Slack.
2. **QR pairing**: one-time scan from the WhatsApp mobile app when Phase 0 runs (dashboard will render the QR).
3. **Group names**: confirm the allowlist pattern — assumed all groups matching "Hermes" in the name.
4. Decide **personal number vs spare number** (Risk 1).

## Build plan & agent assignment

You listed: opus, sonnet, grok 4.5 (CLI), composer 2.5 (cursor), gpt 5.6-luna, sol via codex. Assignment — matched to module difficulty, with cross-model review where it pays:

| Phase | Work | Agent | Why |
|---|---|---|---|
| 0 | Pairing spike: Baileys connect, QR, list groups, receive one live message from a Hermes group | **Opus** (build agent) | De-risks the whole plan; auth-state/reconnect is the fiddly part |
| 1 | `src/whatsapp/` module: client lifecycle, SQLite message store, backfill, group filter | **Opus** | Core module, event-driven edge cases (reconnect, dedupe, cursor) |
| 1R | Review Phase 1 | **Sol via codex** | Strongest cross-model reviewer; different model family catches what the builder's family repeats |
| 2a | Extraction pipeline: prompt + `claude -p` runner integration + task state machine | **Opus** | Prompt design + state transitions is the quality-critical piece |
| 2b | Notion sync client + database bootstrap | **Sonnet** | Well-scoped CRUD against a documented API |
| 2c | mentor-links.csv → Notion sub-page (one-shot script) | **Grok 4.5 CLI** | Isolated, cheap, trivially verifiable (headless `--always-approve`, diff verified after per standing note) |
| 2R | Review Phase 2 (per-commit) | **Sol via codex** | Same reviewer, continuity across rounds |
| 3 | Live query-reply flow + guardrails + kill switch | **Opus** | Sends as Pranav — highest care, tightest review |
| 3R | Adversarial review of reply guardrails specifically | **Grok 4.5** | Second independent family on the only outward-facing surface |

**Not used:** **composer 2.5** — no frontend surface (the dashboard gets a small status card at most, not worth a dedicated frontend agent); **gpt 5.6-luna** — adds a third model family with no lane that Opus/Sonnet/sol don't already cover; more coordination than value here.

Orchestration: me (Fable 5) — spec, dispatch with conventions + relevant memory in-prompt, post-build verification checklist (read files → typecheck → tests → spec match → two clean passes) before each merge. Build → review → fix → re-review loop per phase, one branch per concern off `main`.

## Phasing / sequence

- **Phase 0 (spike, ~small)**: pairing + read one live message. Go/no-go on Baileys; fallback decision if it fails.
- **Phase 1**: ingestion + store + backfill, read-only. Verify: messages from all Hermes groups landing in SQLite.
- **Phase 2**: extraction + Notion sync + mentor-links sub-page. Verify: tasklist on the Notion page matches a hand-check of one group's messages.
- **Phase 3**: reply flow, behind `WHATSAPP_REPLIES_ENABLED`, enabled only after you've watched Phase 2 output for a bit.

## Open questions for approval

1. Baileys-in-junior approach OK, or prefer the lharries off-the-shelf bridge / a standalone service?
2. Personal number or spare number for pairing?
3. Reply-as-Pranav with the `🤖` prefix + allow-list guardrails acceptable?
4. Notion one-way sync (SQLite wins) OK for v1, or do you need to edit statuses in Notion by hand?
