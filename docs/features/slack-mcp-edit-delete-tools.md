# Slack MCP: Edit & Delete Message Tools

> Status: **Proposed** — scoping doc. Not yet built.
> Extends [mcp-server.md](./mcp-server.md). Lives alongside the other Slack MCP tools in `src/mcp/slack-server.ts`.

## Problem

Junior's Slack MCP server can `slack_send_message` but cannot revise or retract a message once posted. Two recurring needs go unmet:

1. **Edit** — An agent posts a status pill ("🔄 reproducing…"), then wants to flip it to "✅ reproduced" *in place* rather than spamming the thread with a new message. Today the streaming layer re-posts; agents driving their own messages have no in-place update path.
2. **Delete** — An agent posts something it shouldn't have (a wrong answer it immediately corrects, a duplicate, a noisy intermediate), and wants to remove it. Today it stays forever; the only mitigation is posting a correction below it.

Both map directly onto Slack Web API methods Junior's bot token can already call against its **own** messages: `chat.update` and `chat.delete`. The work is wiring them as MCP tools with the same care the send path takes around action buttons.

**Who has this problem:** Any spawned agent that posts via `slack_send_message` and later wants to revise/retract — status pills, lead orchestration, correction flows.

**"Finally" moment:** An agent edits its own status message to reflect new state, or deletes a message it regrets, without cluttering the thread.

## Scope

In scope:
- `slack_edit_message` → `chat.update`
- `slack_delete_message` → `chat.delete`
- Action-button bookkeeping cleanup when an edited/deleted message carried live buttons.

Out of scope (explicitly):
- Editing/deleting messages **not** posted by Junior's bot token. Slack rejects this (`cant_update_message` / `cant_delete_message`) for a non-admin bot token. We surface the error; we do not pursue admin scopes.
- Bulk edit/delete, scheduled-message edits, or editing file uploads.
- Changing `username` / `icon_emoji` of an already-posted message — `chat.update` does not honor identity overrides (see Constraints). Out of scope.

## Constraints & Slack API facts

- **Both methods need `channel` + `ts`.** Read tools (`slack_read_channel`, `slack_read_thread`) already print each message as `[<ts>] Bot(...): text`, so agents have a discovery path for the `ts`. The `slack_send_message` result also returns the posted `ts`.
- **Bot can only mutate its own messages.** `chat.update`/`chat.delete` with the bot token succeed only on messages authored by that token. Non-bot or other-bot messages → Slack error. Fail with a clear message; do not retry.
- **Scope:** both methods require `chat:write` — already granted (see [mcp-server.md](./mcp-server.md) Dependencies). No new bot scope needed.
- **`chat.update` cannot change identity.** `username`, `icon_emoji`, `icon_url` are ignored by `chat.update`; the message keeps its original poster identity. Tool schema must not expose those params (avoids a silent no-op footgun).
- **`chat.update` and blocks.** Updating a message that was posted *with* action `blocks` and passing only `text` will drop the buttons. This is the intended path for "retire these buttons and rewrite the text" — but it must be coordinated with the action store (below), not left to silently desync.

## Action-button interaction (the real design work)

`slack_send_message` may attach interactive buttons, persisted in `SlackActionStore` keyed by `(channel_id, message_ts)` — there is already an index `idx_slack_actions_message ON slack_action_buttons(channel_id, message_ts)` (`src/slack/action-store.ts`). If an agent edits or deletes a message that carries **active** button rows, those rows must be reconciled or they become click-targets pointing at a message whose buttons are gone (or whose blocks were overwritten):

- **Delete:** disable all active button rows for that `(channel_id, message_ts)` before/after `chat.delete`. A clicked-after-delete token should resolve to "this action is no longer available" rather than erroring deep in the handler.
- **Edit:** if the new text drops the blocks, disable the message's active button rows. If we later support edits that *preserve* blocks, leave rows intact.

`SlackActionStore` currently exposes `disableAgentActionMessages(store, slack, threadTs, agent)` (disable by thread+agent) but **no** "disable by message_ts". This proposal adds one:

```ts
// src/slack/action-store.ts
async disableByMessage(channelId: string, messageTs: string): Promise<number>
//   UPDATE slack_action_buttons SET status = 'disabled'
//   WHERE channel_id = ? AND message_ts = ? AND status = 'active'
//   returns rows affected
```

Both new MCP tools call it. The existing `idx_slack_actions_message` index already covers the WHERE clause.

## Tool specs

### `slack_edit_message` → `chat.update`

```
inputSchema:
  channel_id: string          // Channel ID the message is in
  ts:         string          // Timestamp of the message to edit (bot's own message)
  text:       string          // New message text (Slack mrkdwn)
  // no username/icon_* — chat.update ignores identity overrides
```

Handler:
1. Run `text` through `prepareSlackResponseWithActions` for consistency with the send path? — **No.** Edit is a plain text replace; keep it simple and predictable. (Decision: edits do not parse new action directives. If an agent wants buttons, it sends a new message.)
2. `await slack.chat.update({ channel: channel_id, ts, text })`.
3. If the message had active button rows, `await slackActionStore?.disableByMessage(channel_id, ts)` (the rewritten text overwrote the blocks).
4. On `cant_update_message` / `message_not_found` / `edit_window_closed`, return a clear error string (don't throw raw).
5. Return `Message edited (ts: <ts>)`.

### `slack_delete_message` → `chat.delete`

```
inputSchema:
  channel_id: string          // Channel ID the message is in
  ts:         string          // Timestamp of the message to delete (bot's own message)
```

Handler:
1. `await slackActionStore?.disableByMessage(channel_id, ts)` first (buttons point at a message about to vanish).
2. `await slack.chat.delete({ channel: channel_id, ts })`.
3. On `cant_delete_message` / `message_not_found`, return a clear error string.
4. Return `Message deleted (ts: <ts>)`.

Both register in `registerTools()` (`src/mcp/slack-server.ts:49`) next to `slack_send_message`, using the same `server.registerTool(name, {description, inputSchema}, handler)` shape and the module-level `slack: WebClient`.

## Implementation plan

1. **`src/slack/action-store.ts`** — add `disableByMessage(channelId, messageTs)`; unit-test it (insert active rows → call → assert status flips to `disabled`, returns count).
2. **`src/mcp/slack-server.ts`** — register `slack_edit_message` and `slack_delete_message` per specs above; wire `slackActionStore?.disableByMessage` calls; map known Slack errors to friendly strings.
3. **`.claude/settings.json`** — already grants `mcp__slack-bot__*`; no change. Confirm `mcp__slack-bot__slack_edit_message` / `_delete_message` fall under the wildcard.
4. **`src/mcp/slack-server.test.ts`** — add cases: edit own message (mock `chat.update`), delete own message (mock `chat.delete`), delete with active buttons asserts `disableByMessage` called, error mapping for `cant_update_message`/`cant_delete_message`.
5. **Docs** — add the two tools to the Tools table in [mcp-server.md](./mcp-server.md); update `docs/code_index/mcp-server.md`.

## Open questions

1. **Should edit re-parse action directives?** Proposed answer: no — keeps edit deterministic and avoids double-registering buttons. Confirm with how status-pill flows want to behave.
2. **Audit trail.** Deletes are irreversible and invisible after the fact. Do we want a log line (agent, channel, ts, original text) so a deleted message isn't a total black hole? Low cost, recommended.
3. **Guardrail against deleting human / other-agent messages.** The bot token can't delete non-bot messages anyway (Slack rejects), so this is self-limiting — but a pre-check that the `ts` belongs to the bot (via the read path) could give a friendlier error than Slack's raw `cant_delete_message`. Optional.

## Test (acceptance)

- Agent posts a message, edits it → thread shows the new text in place, no duplicate.
- Agent posts a message with buttons, deletes it → message gone, button tokens for that `ts` are `disabled`, a post-delete click resolves to "no longer available".
- Agent tries to edit/delete a human's message → friendly error, no crash.
- `bun run typecheck` clean; `slack-server.test.ts` + `action-store` tests green.
