# Persistent Agents

> **Status (2026-07 — 3-way agent merge):** `lead` and `thinker` retired as standalone agent definitions. There is now one orchestrator (`default.md`); support-channel sessions keep the `lead` session marker, which the router aliases to `default.md` and layers `common/bug-pipeline.md` on top of. The orchestrator runs the old thinker methodology **itself** in its own turn(s) — Phase 1 (3-5 hypotheses, cheap-evidence verification, mock-run protocol, anti-anchoring, Message 1 + human gate) and Phase 2 (scoping.md, then dispatch the implementation to `build`/`frontend` via the Task tool; the orchestrator never edits product code). The two-turn human gate survives. `reproducer` and `review` stay as persistent workers; `!thinker` no longer exists as a directive. Read the sections below with those substitutions: "thinker" → "the orchestrator's Phase 1/2", "!thinker proceed" → "the orchestrator posting Message 1 and stopping for the gate", "fix scoped by thinker" → "fix scoped by the orchestrator and dispatched to build/frontend via Task".

> **Current runtime note:** Core Slack identities are `default`, `lead`, `reproducer`, `review`, and `echo`; private agents are loaded from `agents-org`. The long iteration and example sections below are retained as a migration/design record. Current dispatch and safety behavior is indexed in [`../code_index/persistent-agents.md`](../code_index/persistent-agents.md) and [`../code_index/agent-catalog.md`](../code_index/agent-catalog.md).

> Same backbone as the wiped `support-lead-persistent-agents.md` (persistent Claude Code session per agent role, one thread holds many agent sessions, each agent posts to Slack with its own identity). Refined design after a session of pruning: lead-only dispatch (workers can't tag each other), `NO_SLACK_MESSAGE` for silence, observability-before-UI as a hard invariant, no internal-dispatch-plus-audit-log split. First product use is the bug pipeline; substrate is reusable.

## Problem

When a bug is reported in `#bugs-backlog`, Junior needs to triage it: pull observability data (New Relic logs, Sentry exceptions, Vercel deploy state), reproduce the failure, scope a fix, ship it, validate, and email the user. The previous attempt collapsed the entire pipeline into a single `support-lead` Claude session that spawned sub-agents internally via the Task tool. Three problems with that shape:

1. **Bottleneck.** Every cross-agent message went through the lead. A thinker re-querying research = lead reads workspace, lead re-prompts research, research writes back, lead reads, lead re-prompts thinker. Two lead turns per inter-agent exchange.
2. **Context loss.** Each Task spawn started cold. Three re-query rounds = three full cold reloads of workspace.md + classifier.md + original-report.md.
3. **Opacity.** Humans only saw Junior's summaries. They couldn't see what research actually found, where the thinker pushed back, or what reasoning produced the chosen fix. The full picture was buried in workspace.md files on disk.

**Who has this problem:** Pranav (operator), and any human watching `#bugs-backlog` for what Junior is doing on a bug.
**What happens today:** Support-channel sessions route to the merged `default` orchestrator (with the `lead` marker where configured); `reproducer` and `review` remain addressable persistent workers, while private overlay workers are registered at boot. Typed product/bug pipeline persistence is available behind `PIPELINE_RUNTIME_MODE` and is off by default.
**Painful part:** A bug pipeline is fundamentally a **multi-actor parallel system** dressed up to look sequential. Observability fetchers (NR, Sentry, Vercel) are independent and can race. The reproducer needs their output as context. Re-queries between thinker and research happen multiple times. Forcing this into a single Claude session loses parallelism and observability.
**"Finally" moment:** A bug arrives in `#bugs-backlog`. The thread shows distinct messages from Lead, Research, Sentry, Vercel, Reproducer — each with their own identity, posting as they finish work, in parallel where it makes sense. Humans can `!research <follow-up>` directly. The full investigation reads top-to-bottom in the thread:

```
[Junior]        bug arrived. fanning out observability before reproduction.
                (status pill: "calling nr-research, sentry-fetch, vercel-status (3 in progress)")
                (status pill updates: "nr-research done, 2 in progress" → "all 3 done")
[Junior]        observability done.
                NR: 1,247 errors / 860 users, deploy app-backend@a3f2c1 correlation strong
                Sentry: no client-side exceptions for /events in last 2h
                Vercel: a3f2c1 deployed 2h before first error
                Full findings in research.md, sentry.md, vercel.md.
                Blast radius is wide — bumping P1 → P0 before reproducing.
                !reproducer GET /api/v1/events?past_events=true returning 500 for user@example.com
[Reproducer]    reproduced — blank page on /events, 500 on GET /api/v1/events    by reproducer
[Junior]        scope this fix.
                !thinker reproduction shows stale cache, NRQL points at events-service.ts deploy a3f2c1
[Thinker]       Hypotheses: (1) cache key collision (2) cache TTL miss (3) stale read after deploy.
                Verified each — going with #3: deploy a3f2c1 changed cache key format, old keys still in flight.
                Fix lives in events-service.ts:142.    by thinker
[Junior]        thinker is going with hypothesis #3. approve / reject / push back with new context?
[Pranav]        approve
[Junior]        !thinker proceed
[Thinker]       scoping done — invalidate old cache keys on read miss after deploy.
                file: events-service.ts:142, risk: low, test: unit + manual repro.
                scoping.md    by thinker
[Junior]        scope posted. @udayan approve / reject?
[Pranav]        approve
```

Every orchestration decision is visible. Humans can see exactly what the lead asked, what agents found, where the lead made its calls. The Slack thread IS the audit trail — no separate "post for visibility" hack needed.

## Full Vision

- **Two tiers of agents**: **persistent** (lead, reproducer, thinker, review) and **sub-agent / Task tool** (nr-research, sentry-fetch, vercel-status, email-drafter). Reproducer is two-phase — `reproduction` at the top and `validation` at the bottom — using `--resume` to retain test setup across phases.
- **Persistent agents** have their own Claude Code session per bug thread, post to Slack with their own username + icon, and resume across turns via `--resume`. They participate in the human-readable conversation.
- **Sub-agents** are stateless tool calls invoked by persistent agents via the Task tool. They never post to Slack directly — output goes to bug-folder files (`research.md`, `sentry.md`, `vercel.md`, `email.md`). The calling persistent agent synthesizes findings for the human.
- Lead orchestrates by emitting `!<agent> <prompt>` lines in normal Slack messages. Router parses those lines and dispatches to persistent agents only. Sub-agents are never invoked via `!<agent>` — only via Task tool, and only by persistent agents.
- **Orchestrators** (lead, default Junior) can emit `!<agent>` directives — both share the same full dispatch power; they differ only in slack identity and which channels route to them. Workers can use the Task tool for stateless data fetches but cannot trigger more persistent work, with the narrow exceptions in `WORKER_DISPATCH_ALLOW` (e.g. thinker → review / reproducer for happy-path chains).
- Lead is awoken on every event in the thread (human messages and worker responses) and can choose silence (via `NO_SLACK_MESSAGE` or by posting commentary with no directives) — silence breaks the cycle.
- Observability fan-out: lead issues parallel Task calls to nr-research / sentry-fetch / vercel-status in **one turn**. All three run concurrently. Once all return, lead reads their files, synthesizes findings into a single Slack message, then dispatches `!reproducer` with that context (read-only bugs only — write-path bugs go straight to thinker).
- Reproducer runs _after_ observability completes and only for read-only bugs — it needs failing endpoints, exception classes, deploy state as context. Write-path bugs skip reproducer (both phases) to avoid prod side-effects.
- Re-queries go through lead. Round caps (research max 3, review max 2) live in the lead's prompt as semantic guardrails, not in the router.
- Live progress is signaled via a **status pill** that streams `tool_use` events (one pill per active agent session). Humans see "calling nr-research, sentry-fetch, vercel-status (3 in progress)" → "1 done, 2 in progress" → cleared. `tool_result` content stays internal.

## Invariants (architectural commitments)

1. **Observability ALWAYS precedes UI verification.** When reproducer runs (read-only bugs only), it always has observability context, never cold. Write-path bugs skip both phases of reproducer — observability still runs first, it just feeds thinker directly.
2. **Only orchestrators (lead, default Junior) emit `!<agent>` directives.** Workers can post any commentary, but they cannot trigger more work — except for the narrow happy-path chains declared in `WORKER_DISPATCH_ALLOW` (e.g. thinker → review).
3. **The Slack thread IS the message bus.** No internal-dispatch-plus-audit-log split. Every cross-agent call goes through Slack events. One source of truth, full audit trail by construction.
4. **Silence is a first-class action.** Cycle-break by composition, not enforcement. No router-level retry counters.

## Dependencies

- [slack-event-handler.md](slack-event-handler.md) — produces events the router consumes
- [session-management.md](session-management.md) — the per-thread session model that gets extended for multi-agent
- [claude-spawner.md](claude-spawner.md) — spawns Claude processes; needs to accept an agent identity for postMessage
- [mcp-server.md](mcp-server.md) — `slack_send_message` is what agents use to post

## Data Model

`ThreadSession` extends to hold per-agent sub-sessions:

```typescript
interface ThreadSession {
  threadId: string;
  channel: string;
  // Lead's session — the default recipient. Created on first event.
  leadSessionId: string | null;
  // Per-agent sessions, created lazily when lead first dispatches them.
  agentSessions: Map<string, AgentSession>;
  bugId: string | null;
  status: "idle" | "active" | "needs-human" | "done";
  // existing fields (worktreePath, targetRepo, etc.) carry through.
  // Bug-pipeline threads also populate worktreePaths, a Record<repoName, path>
  // populated by lead via the `mcp__slack-bot__register_worktree` MCP tool on
  // intake. Subsequent agents see the paths in the multi-repo `<workspace>`
  // block at the top of their prompt and use them for ALL reads/edits/git
  // ops — never the bare repos under `~/projects/`. See
  // [bug-pipeline-worktrees.md](bug-pipeline-worktrees.md) and
  // [worktree-manager.md](worktree-manager.md).
  worktreePaths: Record<string, string>;
}

// One AgentSession per *persistent* agent dispatched in this thread.
// Sub-agents (nr-research, sentry-fetch, etc.) are Task-tool calls
// from inside a persistent agent's session — no AgentSession entry.
interface AgentSession {
  agentName: string; // "reproducer", "thinker", "review"
  sessionId: string | null; // Claude Code session ID for --resume
  status: "idle" | "busy" | "done" | "failed";
  pendingMessages: PendingMessage[]; // buffer for in-flight !<agent> while busy
  lastActivity: number;
  pid: number | null;
}
```

Agent identities for Slack posting (persistent agents only — sub-agents never post):

```typescript
const AGENT_IDENTITIES: Record<
  string,
  { username: string; iconEmoji?: string; imageUrl?: string }
> = {
  // Default Junior — the bot's main face for any-channel @mentions.
  default: { username: "Junior", iconEmoji: ":face_with_cowboy_hat:" },
  // Lead — bug-pipeline orchestrator. Distinct slack username so
  // `agentForUsername` can resolve self-bot posts back to the right role.
  lead: { username: "Junior (Lead)", iconEmoji: ":face_with_cowboy_hat:" },
  reproducer: { username: "Reproducer", iconEmoji: ":mag:" },
  thinker: { username: "Thinker", iconEmoji: ":wrench:" },
  review: { username: "Reviewer", iconEmoji: ":eyes:" },
};
// Private / org-specific worker identities are NOT registered here — they
// declare `username` + `iconEmoji` or `imageUrl` in their own .md frontmatter and get
// merged in at startup by `loadOverlayIdentities` from the org overlay
// directory. This keeps the public repo free of org-specific agent names.
```

### Persistent agents vs sub-agents

| Tier                      | Agents                                                  | Properties                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Persistent**            | lead, reproducer, thinker, review                       | Own Claude session per bug thread, resumed via `--resume`. Posts to Slack with own identity. Addressable via `!<agent>`. Multi-turn / stateful. Has an `AgentSession` entry. **Reproducer is two-phase** — phase=reproduction (top) and phase=validation (bottom, on the local fix branch before merge). |
| **Sub-agent (Task tool)** | nr-research, sentry-fetch, vercel-status, email-drafter | Stateless. Spawned via Task tool from inside a persistent agent's session. Output goes to bug-folder files (`research.md`, `sentry.md`, `vercel.md`, `email.md`). Never posts to Slack. Never addressed via `!<agent>`. No `AgentSession` entry.                                                         |

Sub-agents are tools, not participants. The persistent agent that calls them references the file path + key findings in its Slack message. This keeps the channel a clean human-↔-persistent-agent conversation while preserving full audit trails on disk.

## Routing

All agents run under the same Slack bot user ID. Bot messages from `chat.postMessage` trigger Slack events too — so when the lead posts `!nr-research check NR logs`, that event comes back to the bot and could trigger infinite loops if not handled. The 4-case table below disambiguates: human vs bot (by user ID), and within each, prefixed (`!<agent>`) vs not. Other bots in the workspace (Friday, Doraemon) have different bot IDs and are filtered at event ingestion before reaching this table.

Every Slack message in a `#bugs-backlog` thread goes through the router. Four cases, one path:

| Source   | Prefix      | Routes to                                          |
| -------- | ----------- | -------------------------------------------------- |
| Human    | (no prefix) | lead                                               |
| Human    | `!<agent>`  | that agent                                         |
| Bot (us) | `!<agent>`  | that agent — **emitted by orchestrators (lead, default Junior)** |
| Bot (us) | (no prefix) | lead (lead reads agent responses; can stay silent) |

Notes:

- "Bot (us)" = our bot's user ID. Other bots in the workspace (Friday, Doraemon) are ignored at event ingestion.
- Multi-directive dispatch: one Slack message can contain multiple `!<agent>` lines. Each line is a separate dispatch; commentary between/around them is allowed.
- Buffer per agent: if a `!<agent>` arrives while that agent is `busy`, buffer in `agentSessions[name].pendingMessages`. Drain when the agent's process exits, same buffer/drain pattern Junior already uses per thread, scoped per agent.
- The router only recognizes prefixes that match persistent agents (entries in `AGENT_IDENTITIES`). Anything else is treated as a plain message — `!nr-research <q>` from a human falls through to lead the same way an unprefixed message would. There's no special case for sub-agent names; the router simply doesn't know they exist. Lead reads the message text and may interpret a literal `!<sub-agent>` line as a request, but that's lead's call, not the router's.

### Cycle break

Lead is awoken on every event in the thread (human messages and worker responses). Two ways the cycle breaks:

1. **`NO_SLACK_MESSAGE`** — lead's output gets suppressed at the post-to-Slack boundary (existing primitive, hardened in earlier work). No Slack post → no event → no further routing. Right when lead has nothing to say to humans either.
2. **Posted message with no `!<agent>` directives** — lead posts commentary like "research done, waiting on sentry/vercel," router parses, finds zero directives, no dispatch. Humans see the status, pipeline pauses.

Both are first-class. Lead's prompt picks: silent if there's truly nothing useful to say, commentary-only if humans benefit from a status note.

### Agent message format

Each **persistent agent** posts via `slack_send_message` MCP using its identity from `AGENT_IDENTITIES` (the `username` and `icon_emoji` params on `chat.postMessage`). To make agent attribution unambiguous in notifications, search results, and threaded replies (where the username column may be truncated or hidden), every persistent-agent message **except the lead's** ends with `by <agentname>`. Lead messages don't need the suffix — Junior is the default identity in the thread.

Sub-agents do not post to Slack at all (see "Sub-agent invocation" below). Their findings live in bug-folder files; the calling persistent agent references the file path in its own Slack message.

### Multi-directive dispatch (parallel persistent-agent fan-out)

For dispatching multiple **persistent** agents in one turn (rare — most pipelines are sequential past the observability fan-out, since reproducer/thinker/review depend on each other):

```
!reproducer reproduce: <user story>
!review <something parallel>
```

Router rule: every line matching `^!<agent> ` in the message is a separate dispatch. Each persistent agent gets its own Claude process. Commentary lines are ignored by the router (humans still see them).

For observability fan-out (NR / Sentry / Vercel), the lead does NOT use multi-directive dispatch — it uses parallel Task calls instead (see below).

**Operational directives** (added with the bug-pipeline worktree feature, [bug-pipeline-worktrees.md](bug-pipeline-worktrees.md)) sit at the same syntactic layer as `!<agent>` but do NOT spawn a Claude process — junior handles them inline:

- `!devserver <branch> [repo]` — acquire the per-repo dev-server slot, check out the branch in junior's dedicated dev-server worktree, restart `pnpm dev` if needed, post `ready @ localhost:<port>` when up. `repo` defaults to the entries in `session.worktreePaths` filtered to those with a `devCommand` configured; if `session.worktreePaths` is empty (non-bug-pipeline thread, or one that called `!devserver` before lead's intake registered worktrees), the fallback is every repo with a `devCommand` configured. Reproducer's phase-2 validation flow gates on this; humans can post it directly too.
- `!devserver status` — show queue depth + holder for every repo with a `devCommand`.
- `!devserver kill <repo>` — kill the dev server for a repo (manual escape hatch when junior's tracking drifts). Bare `!devserver kill` (no repo) returns a usage hint.

The dispatcher (`src/support/router.ts`) intercepts `!devserver` lines BEFORE the persistent-agent routing path. See [process-lifecycle.md](process-lifecycle.md) for the queue's lockfile + `onCompromised` mechanics.

### Sub-agent invocation (Task tool, internal)

For stateless data fetches (NR, Sentry, Vercel, email drafting), the lead invokes them via the Task tool inside its own Claude turn. Multiple Task calls in one assistant message run concurrently:

```
(inside lead's session, one assistant message, parallel)
Task(subagent_type: "nr-research",   prompt: "events errors last 2h, user user@example.com")
Task(subagent_type: "sentry-fetch",  prompt: "/events exceptions last 2h")
Task(subagent_type: "vercel-status", prompt: "latest deploy state")
```

Each sub-agent writes its findings to `$BUG_DIR/<name>.md`, returns a one-line summary as the Task tool result, and exits. The lead reads the files, synthesizes for humans, posts the rollup to Slack, and decides next steps.

The status pill streams `tool_use` events for these Task calls so humans see live progress: `"calling nr-research, sentry-fetch, vercel-status (3 in progress)"` → `"nr-research done, 2 in progress"` → cleared at turn end. `tool_result` content stays internal.

## What Changes in Junior's Code

### Router (new module: `src/support/router.ts`)

Sits between `events.ts` and `SessionManager.handleMessage()`. Two responsibilities:

1. **Decide the recipient session** based on the 4-case table above.
2. **Parse multi-directive dispatch** — for messages from the bot's own user ID, scan for all `^!<agent> ` lines, dispatch each to its own session.

Replaces the current direct path from `events.ts → SessionManager.handleMessage()` for `#bugs-backlog` threads. Non-bug-pipeline threads (e.g. `#junior` adhoc work) keep the existing single-session path.

### Session store

`ThreadSession` gains `leadSessionId` + `agentSessions: Map<string, AgentSession>`. SQLite schema adds:

```sql
CREATE TABLE agent_sessions (
  thread_id   TEXT NOT NULL,
  agent_name  TEXT NOT NULL,
  session_id  TEXT,
  status      TEXT DEFAULT 'idle',
  last_activity INTEGER,
  PRIMARY KEY (thread_id, agent_name),
  FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
);
```

Pending per-agent messages are persisted but treated as stale on restart (matches existing thread-level behavior).

### Spawner

`spawnClaude()` accepts an agent identity (`username`, `iconEmoji`) for **persistent agents only**. When the spawn produces output, it posts via `slack_send_message` MCP using that identity. Sub-agents are spawned via the Task tool from inside a persistent agent's session — they don't go through `spawnClaude()`.

### Status pill (live progress)

Already wired in `src/slack/responder.ts:54` (`updateStatus`) — posts a transient Slack message and edits it as updates roll in, debounced 1s, deleted on turn completion. Existing flow streams `tool_use` events as status text via `formatToolStatuses` (`src/slack/formatting.ts:6`).

Two changes needed for the new architecture:

1. **Per-agent keying — shipped.** `SlackResponder.statusMessages` is keyed by
   `${threadTs}:${agentName}`, so concurrent persistent agents in one thread do
   not clobber each other's status pill.
2. **Task-tool formatter.** Add a `"Task"` case to `formatToolBlock` (`src/slack/formatting.ts:31`) that pulls `subagent_type` from the input and renders `Calling <subagent_type>`. For parallel Task calls in one assistant event, `formatToolStatuses` should roll up: `"Calling nr-research, sentry-fetch, vercel-status (3 in progress)"` instead of returning N strings (which the current debounce eats anyway).

`tool_result` events stay filtered out — content stays internal to the calling persistent agent's session.

### Lead prompt

The support orchestrator uses `.claude/agents/default.md` with the `lead` marker
and the appended `common/bug-pipeline.md`; there is no public `.claude/agents/lead.md`.
The merged orchestrator prompt teaches:

- The dispatch syntax: write `!<agent> <prompt>` on its own line to dispatch.
- State-checking: read `agentSessions[name].status` before emitting. Don't dispatch a `busy` agent (will buffer); don't dispatch a `done` one without good reason.
- Round caps: `rounds.research ≤ 3`, `rounds.review ≤ 2`, `rounds.reproducer ≤ 2`. Track in `state.json` per bug. At cap → escalate to human, not re-spawn.
- The observability-before-reproduction invariant.
- When to use `NO_SLACK_MESSAGE` vs commentary-with-no-directives.
- The mismatch outcome and how to handle it (don't proceed to research with the wrong issue).

## Iterations

### Iteration 0: Substrate (~4h) — shipped

Multi-session thread model + router + agent identities. No real agents yet — test with a fake `!echo` agent.

**What it adds:**

- `AgentSession` type
- `agentSessions: Map<string, AgentSession>` on `ThreadSession`
- SQLite `agent_sessions` table + persistence
- `src/support/router.ts` implementing the 4-case routing table + multi-directive parsing
- `AGENT_IDENTITIES` config map
- `spawnClaude()` accepts agent identity, posts via `slack_send_message` with that identity
- Router wired to `#bugs-backlog` threads only
- `NO_SLACK_MESSAGE` already works at the post boundary — verify it doesn't fire any events from the suppression path

**Test:**

- Create a `lead` session in a test thread. Post a message manually as the bot containing `!echo hello`. Verify a fresh `echo` agent session is created, posts back as "Echo" identity. Verify lead's session is unaffected.
- Post `!echo first\n!echo second` — verify only one echo session exists; second message buffered.
- Post `!echo` while echo is busy — verify it buffers and drains after the first turn.
- Lead outputs `NO_SLACK_MESSAGE` — verify nothing is posted, no further events fire.

**Defers:** Real agents, lead orchestration prompt, parallel observability.

### Iteration 1: First sub-agent — `nr-research` (~3h) — shipped in overlays

Validates the sub-agent (Task tool) tier end-to-end. nr-research is invoked from within a Claude session (initially the operator's, later the lead's), runs an NRQL query, writes findings to `$BUG_DIR/research.md`, returns a one-line summary, and exits. No Slack identity, no AgentSession entry.

**What it adds:**

- `support/agents/nr-research/prompt.md` (Claude Code sub-agent definition with `subagent_type: nr-research`)
- Tools: `newrelic` CLI as primary, NR MCP fallback
- Output contract: writes `$BUG_DIR/research.md` with the structured findings; returns a one-line summary like `"DONE: 1,247 errors across 860 users — see research.md"` as the Task tool result
- Status pill: a `"Task"` case in `formatToolBlock` renders `Calling nr-research`

**Test:** Operator triggers an interactive Claude session in a real bug thread, invokes `Task(subagent_type: "nr-research", prompt: "events errors last 2h, user user@example.com")`. Verify status pill shows `Calling nr-research`, then clears at turn end. Verify `research.md` exists in the bug folder with the findings. Verify the sub-agent never posts to Slack directly.

**Defers:** Sentry, Vercel, parallel fan-out, lead orchestration.

### Iteration 2: Parallel sub-agents — `sentry-fetch` + `vercel-status` (~3h) — shipped in overlays

Prove parallel Task-tool fan-out.

**What it adds:**

- `support/agents/sentry-fetch/prompt.md` (sub-agent, `sentry-cli` as the tool, writes `$BUG_DIR/sentry.md`)
- `support/agents/vercel-status/prompt.md` (sub-agent, vercel MCP, writes `$BUG_DIR/vercel.md`)
- Status pill rollup: `formatToolStatuses` handles N parallel Task calls in one assistant event by rendering one combined string (`"Calling nr-research, sentry-fetch, vercel-status (3 in progress)"`) — no per-call updates clobbering each other.

**Test:** Operator session in a real bug thread issues 3 parallel Task calls in one turn. Verify status pill shows the rollup, updates as each finishes, clears at turn end. Verify all 3 files (`research.md`, `sentry.md`, `vercel.md`) are written. Verify no Slack posts from the sub-agents themselves.

**Defers:** Reproducer, lead orchestration.

### Iteration 3: First persistent agent — `reproducer` (~4h) — shipped

The first real persistent agent on top of the substrate. Single-concern UI walker. Runs after observability completes.

**What it adds:**

- `.claude/agents/reproducer.md` (Claude Code persistent agent definition, addressable via `!reproducer`)
- `AGENT_IDENTITIES` entry for `reproducer`
- `support/agents/reproducer/prompt.md` rewritten from the restored baseline
- Reads `$BUG_DIR/research.md`, `sentry.md`, `vercel.md` as input context — failing endpoints, exception classes, deploy state are hand-fed by the lead
- Tool access: playwright/claude-in-chrome, screenshot, members lookup, admin-credentials.yaml fallbacks
- Outcomes: `reproduced | partial | mismatch | not-reproduced` (mismatch + honesty-over-completion baked in from the start)
- Posts trace + outcome to Slack with `Reproducer` identity, suffixed `by reproducer`
- Manually orchestrated for now: operator types `!reproducer ...` after observability has been run via iters 1+2

**Test:** Real bug thread with observability files already in the bug folder. Post `!reproducer reproduce: <user story>`. Verify Reproducer session created, reads observability files, walks UI, posts trace under `Reproducer` identity. Resume by posting `!reproducer what about the cache header?` — verify same session resumed (preamble-skip after first turn). Test all 4 outcomes including `mismatch`.

**Defers:** Lead-driven orchestration (still manual), thinker/review/email-drafter, reproducer phase=validation.

### Iteration 4: Lead orchestration prompt (~3h) — superseded by the merged orchestrator

Lead actually orchestrates the pipeline instead of being manually invoked.

**What it adds:**

- `default.md` plus the support-only `common/bug-pipeline.md` (there is no `lead.md`)
- Auto-assign `#bugs-backlog` threads to `lead` agent type (already wired via `channelDefaults`)
- Lead's prompt teaches:
  - Bug folder lifecycle: create `support/bugs/<product>/<bug-id>/` on intake (template restored)
  - Observability fan-out: parallel Task calls to nr-research / sentry-fetch / vercel-status in **one assistant message**
  - Synthesis: read the three files after Tasks return, post a rollup to Slack with key findings + file path references
  - `!reproducer` dispatch with synthesized observability context
  - State-checking: read `agentSessions[name].status` before emitting any `!<agent>`
  - Round caps as semantic guardrails (`rounds.research ≤ 3`, `rounds.review ≤ 2`, `rounds.reproducer ≤ 2`); at cap → escalate, not retry
  - When to use `NO_SLACK_MESSAGE` vs commentary-only (silence rules)
  - Mismatch handling (don't proceed to research with the wrong issue)
- `state.json` template restored with `rounds.{reproducer,research,review}` counters

**Test:** End-to-end. Post a real bug in `#bugs-backlog`. Verify:

- Lead creates the bug folder
- Lead's first turn does parallel Task calls; status pill shows `Calling nr-research, sentry-fetch, vercel-status (3 in progress)` and updates as each completes
- Lead posts a single synthesis message after all three return, referencing the three files
- Lead emits `!reproducer ...` with observability-aware context
- On mismatch outcome, lead doesn't dispatch the next stage on the wrong failure
- On `not-reproduced`, lead escalates to human (no auto-retry)

**Defers:** Thinker, review (other persistent agents, next iterations); reproducer phase=validation (after thinker writes a fix branch); email-drafter (sub-agent, later iteration).

## Shortcuts

| Shortcut                                                         | Replaced in                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Observability fan-in waits forever (no timeout)                  | Post-MVP if it bites                                                   |
| Round caps in lead's prompt only (no router enforcement)         | Post-MVP if lead misbehaves                                            |
| Slack-events latency for lead→agent dispatch (1-3s/hop)          | Post-MVP (could add stream-handler interception if it ever feels slow) |
| Manual operator dispatch in iters 1-3 (lead doesn't orchestrate) | Iteration 4                                                            |
| One `lead` agent type, no swap to alternate orchestrators        | Post-MVP                                                               |
| No reaction-based "I'm collapsed/waiting" UX                     | Post-MVP                                                               |

## Cut List (true v2)

- **Sub-agents posting to Slack directly** — would put tool output in the user channel, breaking the "user-facing channel = persistent participants only" rule. Considered and rejected. Files + lead synthesis is the right shape.
- **Streaming `tool_result` content to Slack** — same family. Considered ("we have the data in the stream, why not show it?") and rejected for the same reason: makes sub-agent output format part of user-facing UX. `tool_use` is fine because it only exposes "what step", not raw output.
- **Stream-handler dispatch interception** — bypasses Slack events for lead→agent. Faster, but two-paths-that-must-stay-in-sync is the failure mode we just escaped. Only resurrect if Slack-event latency becomes a real problem.
- **Agent-to-agent direct calls** — workers calling each other without lead. Optimization for re-query loops. Keep prohibited unless we hit a real bottleneck.
- **Per-product persistent agents** — research agent that survives across bugs for the same product, accumulating codebase familiarity. Big win, complex state, post-MVP.
- **DAG-based pipeline** — dependency graph, lead resolves parallelism automatically.
- **Token budget tracking** — per-agent per-bug cost vs the one-shot baseline.
- **Agent self-activation** — agents watch state.json for triggers and wake themselves.
- **Thinker, review, email-drafter, reproducer phase=validation** — agents/phases downstream of reproducer-phase-1. Their iteration plans live in their own feature docs once we get there. Note: validation is reproducer's _second_ phase, not a separate agent — reuses the same persistent session.
