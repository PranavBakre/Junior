# Stream-to-Slack Updates

## Problem

When Claude is working (running tools, reading files, writing code), the Slack thread is silent. Users don't know if it's thinking, stuck, or almost done. The bot needs to parse Claude's streaming events and post meaningful status updates to Slack — not every event, but enough to show progress.

**Who has this problem:** Users watching a Slack thread waiting for Claude to respond.
**What happens today:** Nothing — silence until the final response.
**Painful part:** Too many updates = spam. Too few = "is it dead?" Finding the right granularity. Also: Slack rate limits (~1 msg/sec per channel) mean we can't post every tool call.
**"Finally" moment:** User sees "reading src/auth.ts...", "running tests...", "editing 3 files..." as Claude works, then gets the final response. Feels like watching someone work.

## Full Vision

- Parse stream-json events in real-time
- Post a single "status" message in the thread that gets edited as work progresses
- Status shows: current tool being used, file being read/edited, command being run
- Final response replaces or follows the status message
- Configurable verbosity: quiet (no status), normal (tool summaries), verbose (everything)
- Respect Slack rate limits — batch rapid events, debounce edits
- Handle long responses (Slack limit: 4000 chars per message block, 50 blocks per message)

## Dependencies

- Claude Spawner (feature: [claude-spawner.md](claude-spawner.md)) — emits events
- Slack Event Handler (feature: [slack-event-handler.md](slack-event-handler.md)) — Slack client for posting

## Iterations

### Iteration 0: Final response only (~15 min)

No streaming updates — just post the final `result` event text to Slack.

**What it adds:** On `result` event → `postMessage` to thread. If text is >4000 chars, split into multiple messages.
**Test:** Trigger Claude via Slack. Get one response message in thread after Claude finishes.
**Defers:** Status updates, message editing, rate limiting, verbosity.

### Iteration 1: Status message with edits (~1h)

Post a single status message when Claude starts, edit it as events arrive, then post the final response.

**What it adds:**
- On first `tool_use` event → post status message: "Working on it..."
- On subsequent `tool_use` events → edit the status message with current action
- Debounce edits to 1 per second (Slack rate limit)
- Format tool events as readable status:
  - `Bash` → "Running: `<command>`"
  - `Read` → "Reading `<file_path>`"
  - `Edit`/`Write` → "Editing `<file_path>`"
  - `Grep` → "Searching for `<pattern>`"
  - `Agent` → "Delegating to sub-agent..."
- On `result` → post final response as new message, delete or keep status message

**Test:** Trigger Claude with a multi-step task. See status message update in real-time (debounced). Final response appears as separate message.
**Defers:** Verbosity settings, long response splitting, thinking events.

### Iteration 2: Long response handling (~30 min)

**What it adds:**
- Split responses >4000 chars at paragraph boundaries (not mid-sentence)
- If response has code blocks, keep code blocks intact (don't split inside a block)
- If response is extremely long (>12000 chars / 3 messages), truncate with "... (truncated, full response in thread)"
- Slack Block Kit formatting: use `section` blocks with mrkdwn for better rendering

**Test:** Trigger Claude with a prompt that generates a long response. Response splits cleanly at paragraph boundaries. Code blocks stay intact.
**Defers:** File attachments for very long responses, collapsible sections.

### Iteration 3: Verbosity and quiet mode (~20 min)

**What it adds:**
- Thread-level verbosity setting: `quiet`, `normal`, `verbose`
- Default: `normal` (tool summaries)
- `quiet`: no status updates, only final response
- `verbose`: includes thinking events, full tool inputs
- Set via `!quiet`, `!verbose`, `!normal` commands
- Persist in session

**Test:** `!quiet` then trigger task → no status updates. `!verbose` → see thinking steps and full tool inputs.
**Defers:** Per-channel defaults, per-agent-type defaults.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| No status updates (final response only) | Iteration 1 |
| No long response handling (truncate at 4000) | Iteration 2 |
| Hardcoded normal verbosity | Iteration 3 |

## Cut List (true v2)

- Slack Block Kit interactive elements (expand/collapse sections)
- File attachments for long responses (upload as snippet)
- Progress bar (estimated completion %)
- Token usage display per response
- Thread summary on demand (`!summary` → summarize the whole thread)
