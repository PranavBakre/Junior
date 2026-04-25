# Support Lead — Persistent Agent Sessions

## Problem

The support-lead pipeline (on `feature/support-lead`) spawns sub-agents as one-shot Task tool invocations inside Junior's own Claude Code session. The lead is the only thread participant — it spawns agents internally, reads their output, posts summaries to Slack. Agents never appear in the thread directly. Three problems with this:

1. **Context loss.** Every spawn starts cold. Research re-reads workspace.md, original-report.md, classifier.md from scratch on every re-query. Three re-query rounds = three full cold starts.

2. **Bottleneck.** Everything flows through the lead. The scoper can't ask research a follow-up directly — it writes to workspace, the lead reads it, the lead re-prompts research, research writes back, the lead reads it, the lead re-prompts the scoper. Every inter-agent exchange is two lead turns.

3. **Opacity.** Humans watching the thread only see Junior's summaries. They can't see what the research agent actually found, what the scoper is thinking, or where the reviewer pushed back. The full picture is buried in workspace.md files on disk.

**What persistent agent sessions fix:** Each agent gets its own Claude Code session (like Junior itself). Agents post to the Slack thread with their own identity. They can be addressed directly via `!<agentname>`. They resume via `--resume` instead of starting fresh. Humans see the full conversation unfold.

## Baseline

The `feature/support-lead` branch has:
- `support/SUPPORT_LEAD.md` — orchestrator runbook
- `support/agents/` — 7 sub-agent prompts
- `support/bugs/<product>/<bug-id>/` — per-bug state (state.json, workspace.md, etc.)
- `.claude/agents/support-lead.md` — agent definition for auto-assign
- Auto-assign: threads in #bugs-backlog get support-lead agent

This doc describes the evolution to persistent, Slack-visible agent sessions.

## Architecture

### Agents as thread participants

Each agent is a persistent Claude Code session that posts to Slack with its own identity. Slack's `postMessage` API supports `username` and `icon_url` params, so each agent shows up distinctly in the thread:

```
[Junior]        bug folder created, spawning classifier
[Classifier]    events | P1 | valid — /events page 500 for this user
[Reproducer]    reproduced — blank page on /events, 500 on GET /api/v1/events
[Research]      done — 1,247 errors across ~860 users, deploy correlation: gx-backend@a3f2c1
[Junior]        severity bumped P1 → P0 based on blast radius
[Scoper-Coder]  scoping-done — stale cache key after deploy, fix in events-service.ts:142
[Junior]        scope posted. @udayan approve / reject?
```

Each message gets a `by <agentname>` signature at the end so it's clear even in notifications or search.

### Multi-session threads

Current session model: `Map<threadId, ThreadSession>` — one session per thread.

New model: one thread holds multiple agent sessions.

```typescript
interface ThreadSession {
  threadId: string;
  channel: string;
  leadSessionId: string | null;    // Junior's own session
  agentSessions: Map<string, AgentSession>;
  bugId: string | null;
  status: "idle" | "active" | "done" | "needs-human";
  // ... existing fields
}

interface AgentSession {
  agentName: string;               // "research", "scoper-coder", etc.
  sessionId: string | null;        // Claude Code session ID for --resume
  status: "idle" | "busy" | "done";
  pendingMessages: PendingMessage[];
  lastActivity: number;
  pid: number | null;              // active process PID
}
```

The lead session is the thread's primary session (what auto-assign creates). Agent sessions are created by the lead as the pipeline progresses.

### Message routing

Messages in the thread are routed by prefix:

| Message | Routes to |
|---------|-----------|
| `!research what about the deploy logs?` | research agent's session |
| `!scoper can you check the error handler too?` | scoper-coder agent's session |
| `!classifier` | classifier agent's session |
| `approve` / `reject` (during human gate) | lead session (gate handler) |
| no prefix, no gate | lead session |

When a message routes to a busy agent, it buffers in that agent's `pendingMessages` — same buffer/drain pattern Junior already uses, but per agent instead of per thread.

### Agent identity in Slack

Each agent has a display config:

```typescript
const AGENT_IDENTITIES: Record<string, { username: string; iconEmoji: string }> = {
  'support-lead': { username: 'Junior', iconEmoji: ':cowboy:' },
  'classifier':   { username: 'Classifier', iconEmoji: ':label:' },
  'reproducer':   { username: 'Reproducer', iconEmoji: ':mag:' },
  'research':     { username: 'Research', iconEmoji: ':microscope:' },
  'scoper-coder': { username: 'Scoper', iconEmoji: ':wrench:' },
  'reviewer':     { username: 'Reviewer', iconEmoji: ':eyes:' },
  'build-watcher':{ username: 'Build Watcher', iconEmoji: ':construction:' },
  'email-drafter':{ username: 'Email Drafter', iconEmoji: ':email:' },
};
```

When an agent's Claude Code process produces output, junior's stream handler posts it to Slack using that agent's identity via `chat.postMessage` with `username` and `icon_emoji` params. Each message ends with `by <agentname>`.

### Lead orchestrates on the thread, not internally

The lead doesn't spawn agents behind the scenes. It calls them by posting to the Slack thread:

```
[Junior]        !classifier classify this bug report: <original report text>
[Classifier]    events | P1 | valid — /events page 500 for this user    by classifier
[Junior]        severity P1, product events. !reproducer reproduce this: <steps from report>
[Reproducer]    reproduced — blank page on /events, 500 on GET /api/v1/events    by reproducer
[Junior]        !research pull NR logs for /events errors, last 2h, user priya@example.com
[Research]      1,247 errors across ~860 users, deploy correlation: gx-backend@a3f2c1    by research
[Junior]        blast radius is wide — bumping P1 → P0. !scoper scope this fix
[Scoper-Coder]  !research what changed in events-service.ts in the last deploy?    by scoper
[Research]      gx-backend@a3f2c1 touched events-service.ts:138-155, changed cache key format    by research
[Scoper-Coder]  scoping-done — stale cache key after deploy, fix in events-service.ts:142    by scoper
[Junior]        scope posted. @udayan approve / reject?
```

Every orchestration decision is visible. Humans can see exactly what the lead asked, what agents found, and where re-queries happened. The Slack thread IS the audit trail.

This also means the lead's Claude Code output contains `!<agentname> <prompt>` directives. Junior's stream handler intercepts these:
1. Posts the message to Slack with the lead's identity (for visibility)
2. Routes the prompt to the target agent's session (for execution)
3. The agent runs, and its response is posted with its own identity

Humans can do the same thing — `!research what about X?` in the thread gets routed to research's session, same as when the lead does it.

### Routing layer (shared bot ID problem)

All agents run under the same Slack bot user ID. When a message arrives, the routing layer decides who receives it.

**The problem:** Bot messages from `postMessage` trigger events too. If the lead posts `!research check NR logs`, that event comes from the bot's user ID. Without a routing layer, junior would try to process its own messages, causing infinite loops.

**The solution:** A routing layer between event ingestion and session dispatch.

```
Slack event arrives
  │
  ├─ Is it from our bot user ID?
  │   ├─ YES: is it an agent-to-agent call (contains !<agentname>)?
  │   │   ├─ YES: route to target agent session (internal dispatch, skip Slack posting)
  │   │   └─ NO: ignore (it's our own output, already posted)
  │   └─ NO: continue (human message)
  │
  ├─ Parse !<agentname> prefix
  │   ├─ MATCH + agent session exists: route to that agent
  │   ├─ MATCH + no agent session: route to lead (lead may create it)
  │   └─ NO MATCH: route to lead
  │
  └─ Dispatch to target session (buffer if busy)
```

Three message sources, three routing paths:

| Source | Example | Routing |
|--------|---------|---------|
| **Human → agent** | Human posts `!research what about X?` | Event handler parses prefix, routes to research session |
| **Lead → agent** | Lead's Claude output contains `!research check NR logs` | Stream handler intercepts, routes internally to research session AND posts to Slack for visibility |
| **Agent → agent** | Scoper's output contains `!research what changed in that deploy?` | Stream handler intercepts, routes to research session AND posts to Slack. Lead also sees this in the thread and can intervene if needed |

The key distinction: agent-to-agent calls go through the stream handler (internal routing), not through Slack events. The Slack post is for visibility only. This avoids the bot-processing-own-messages loop.

### When agents should NOT see a message

Most messages are irrelevant to most agents. The routing layer ensures only the addressed agent receives each message:

- `!research <question>` → only research receives it
- `!scoper <instruction>` → only scoper receives it
- `approve` / `reject` → lead handles (it owns human gates)
- No prefix → lead receives it

Agents don't need to filter or ignore messages — they only ever receive messages addressed to them. The routing layer handles the filtering.

### Spawning and resuming

**First invocation** — lead's output contains `!<agentname> <prompt>`. Junior's stream handler:
1. Recognizes the `!<agentname>` directive
2. Creates an AgentSession for that agent
3. Reads the agent's `support/agents/<name>/prompt.md`, resolves it with $BUG_DIR and the lead's prompt text
4. Spawns `claude -p "<resolved prompt>" --output-format stream-json --max-turns 25`
5. Parses stream-json for session ID, stores in `agentSessions[agentName].sessionId`
6. Posts agent's output to Slack with agent identity + `by <agentname>`

**Resume** — lead (or human, or another agent) posts `!<agentname> <follow-up>`:
1. Routing layer finds existing agent session
2. Spawns `claude -p "<follow-up>" --resume <session-id> --output-format stream-json`
3. Agent picks up with full conversation history
4. Posts response to Slack with agent identity

**All agents get persistent sessions** — even one-shot agents like classifier. The session exists and can be resumed if needed (e.g., `!classifier new info came in, re-check severity`).

## What Changes in Junior's Code

### Session store

`ThreadSession` gains `agentSessions: Map<string, AgentSession>`. The store interface stays the same (get/set/delete by threadId), but the session object is richer.

SQLite schema adds an `agent_sessions` table:
```sql
CREATE TABLE agent_sessions (
  thread_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_id TEXT,
  status TEXT DEFAULT 'idle',
  last_activity INTEGER,
  PRIMARY KEY (thread_id, agent_name),
  FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
);
```

### Routing layer (new module: src/support/router.ts)

Sits between event ingestion and session dispatch. Two entry points:

1. **From Slack events** (human messages): parse `!<agentname>` prefix, route to agent or lead
2. **From stream handler** (agent/lead output): intercept `!<agentname>` directives in Claude output, route internally to target agent, post to Slack for visibility

This replaces the current direct `events.ts → SessionManager.handleMessage()` path for #bugs-backlog threads. Non-support threads still use the existing single-session path.

### Spawner changes

Current: `spawnClaude()` takes one session, one prompt, returns one stream.

New: `spawnClaude()` needs to accept an agent identity so it can post output with the right username/icon. The stream handler appends `by <agentname>` to the final message.

### Concurrent processes

Current: one process per thread (buffer everything else).

New: multiple processes can run per thread (one per agent), BUT the lead still orchestrates sequentially by default. Parallel is a future optimization. The session model supports it — each agent has its own `status` and `pid` — but the lead doesn't invoke two agents at once in v1.

## state.json changes

```json
{
  "sessions": {
    "classifier": "session-abc",
    "reproducer": "session-def",
    "research": "session-ghi",
    "scoper-coder": "session-jkl",
    "reviewer": null,
    "build-watcher": null,
    "email-drafter": null
  }
}
```

All agents tracked. Null until first spawn.

## Iterations

### Iteration 0: Multi-session thread model (~3h)

Change the session store to support multiple agent sessions per thread.

**What it adds:**
- `AgentSession` type
- `agentSessions` field on `ThreadSession`
- SQLite `agent_sessions` table
- `createAgentSession(threadId, agentName)`, `getAgentSession(threadId, agentName)`, `updateAgentSession(threadId, agentName, updates)` methods on the store
- Lead can create and track agent sessions

**Test:** Create a thread session. Add agent sessions for classifier, research. Verify they persist across restarts. Verify per-agent status tracking.

**Defers:** Message routing, Slack identity, actual agent spawning.

### Iteration 1: Agent identity in Slack (~2h)

Agents post to Slack with their own username and icon.

**What it adds:**
- `AGENT_IDENTITIES` config map
- Stream handler accepts agent identity, posts with `username` and `icon_emoji`
- Messages end with `by <agentname>`
- Lead's messages still post as Junior (existing behavior)

**Test:** Manually spawn an agent session. Verify its output appears in the Slack thread with a different username and icon than Junior's.

**Defers:** Message routing, `!<agentname>` prefix parsing.

### Iteration 2: Agent message routing (~2h)

Route `!<agentname>` messages to the right agent session.

**What it adds:**
- Parse `!<agentname>` prefix in message handler (before existing command parsing)
- If agent session exists and is idle → resume with `--resume <session-id>` and the message as prompt
- If agent session exists and is busy → buffer in that agent's `pendingMessages`
- If no agent session → fall through to lead (lead may create it)

**Test:** Start a bug pipeline. After research runs, send `!research what about the deploy?` in the thread. Verify it resumes the research session (not the lead) and research posts its own response.

**Defers:** Parallel agent processes.

### Iteration 3: Lead orchestrates on-thread (~3h)

Update the support-lead agent definition so the lead calls agents by outputting `!<agentname> <prompt>` in its Claude response. The stream handler intercepts these directives and routes them.

**What it adds:**
- Stream handler parses lead output for `!<agentname>` directives
- On directive: creates agent session (if new), resolves agent prompt, spawns/resumes Claude process
- Lead's `!<agentname>` message posted to Slack (lead identity) for audit trail
- Agent response posted to Slack (agent identity) with `by <agentname>`
- Lead sees agent responses in the thread and decides next step
- Workspace.md blocks still written by agents (same contract, now also visible in thread)

**What the lead's output looks like:**
```
Bug folder created at support/bugs/events/bug-20260425-events-page-blank.

!classifier Route and validate this bug. Report: member says events page is blank after clicking "Past Events". URL: growthx.club/events. Reporter: priya@example.com.
```

The stream handler sees `!classifier ...`, posts the message to Slack as Junior, and internally spawns the classifier agent.

**Test:** Full pipeline dry run with the events-page-blank example. Verify the thread shows the full conversation between lead and agents. Verify re-query loop works (scoper → `!research` → research responds → lead resumes scoper). Verify human gates (lead posts "approve/reject", human responds, lead continues).

**Defers:** Agent-to-agent direct calls (scoper calling research without lead mediating), parallel spawning, session cleanup.

### Iteration 4: Session cleanup and error recovery (~1h)

**What it adds:**
- Bug reaches `done` or `invalid` → all agent sessions marked done
- `--resume` fails (session expired) → fall back to fresh spawn, log the recovery
- Stale agent sessions (>24h idle) → cleaned up with the thread session
- If agent process crashes → mark agent session as `needs-human`, lead decides next step

### Iteration 5: Agent-to-agent calls (~2h)

Agents can call other agents directly by including `!<agentname>` in their output. The stream handler routes it the same way it routes lead-to-agent calls.

**What it adds:**
- Stream handler applies the same `!<agentname>` interception to ALL agent outputs, not just the lead's
- When scoper outputs `!research what changed in that deploy?`, research gets resumed with that question
- The call is posted to Slack (scoper identity) so lead and humans can see it
- Lead doesn't need to mediate — but can intervene if something looks wrong

**Test:** Run the scoper after research. Scoper outputs a re-query via `!research`. Verify research gets resumed, posts its answer, and scoper continues.

**Why this comes after iteration 3:** The lead-orchestrated path needs to work first. Agent-to-agent is an optimization that reduces lead mediation for the re-query loop.

### Iteration 6: Parallel agent spawning (~2h)

**What it adds:**
- Lead calls multiple agents in one turn: `!reproducer <prompt>\n\n!research <prompt>`
- Stream handler spawns both concurrently
- Each runs in its own agent session, posts to thread independently
- Lead waits for both to complete before continuing
- Buffer/drain still works per-agent — if someone sends `!research` while research is busy, it buffers

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Sequential orchestration (lead controls all) | Iteration 5 (parallel) |
| Lead mediates all inter-agent communication | Iteration 5 (direct agent-to-agent calls) |
| All agents get persistent sessions even if one-shot | Simpler than maintaining two spawn paths |
| No token budget tracking | v2 |

## Cut List (true v2)

- **Agent memory across bugs** — research agent that persists across bugs for the same product. Accumulates codebase familiarity.
- **DAG-based pipeline** — dependency graph instead of linear steps. Lead resolves parallelism automatically.
- **Session pooling** — warm sessions reused across bugs for the same product/repo.
- **Token budget tracking** — measure per-agent per-bug costs. Compare with one-shot baseline.
- **Agent self-activation** — agent watches workspace.md for triggers and wakes itself up. No lead mediation needed.
