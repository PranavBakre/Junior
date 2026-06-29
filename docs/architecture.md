# Architecture

System architecture for junior — the Slack bot that orchestrates coding-agent sessions.

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Bun | Built-in TS, .env, faster child_process spawning. Fallback to Node+tsx if Bun has issues. |
| Slack SDK | @slack/bolt (Socket Mode) | Official SDK. Socket Mode = no public URL needed, works from a laptop. |
| Language | TypeScript (strict, ESM) | Type safety across the session state machine and stream parser. |
| Persistence | SQLite (`bun:sqlite`) | Survives restarts without an external service; memory store remains available for tests/dev. |
| Runner providers | OpenCode by default, Claude as fallback | Provider adapters normalize CLI args, events, resume semantics, cwd, env, and MCP wiring. |
| Driver modes | Headless by default, Claude tmux opt-in | Headless uses one subprocess per turn; tmux keeps an interactive Claude session alive behind a flag. |

## System Diagram

```
Slack (Socket Mode)
    │
    ▼
┌──────────────────────────────────────────────────┐
│  Slack Event Handler                              │
│  (events.ts, commands.ts)                         │
│  Filter → extract threadId → parse !commands      │
└────────────────────┬─────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────┐
│  Session Manager                                  │
│  (manager.ts)                                     │
│                                                   │
│  Map<threadId, ThreadSession>                     │
│                                                   │
│  States: idle ──► busy ──► draining ──► idle     │
│                   ▲  buffer    │  drain           │
│                   │  messages  │  combined         │
│                   └────────────┘                   │
└──────┬───────────────┬───────────────┬───────────┘
       │               │               │
       ▼               ▼               ▼
┌────────────┐  ┌────────────┐  ┌────────────┐
│   Agent    │  │  Worktree  │  │  Runner    │
│   Router   │  │  Manager   │  │ Providers   │
│            │  │            │  │            │
│ Load .md   │  │ git work-  │  │ spawn      │
│ from target│  │ tree in    │  │ opencode /│
│ repo's     │  │ TARGET     │  │ claude     │
│ .claude/   │  │ repos      │  │ parse JSON │
│ agents/    │  │ (not here) │  │            │
└─────┬──────┘  └─────┬──────┘  └──────┬─────┘
      │               │                │
      │   systemPrompt│   cwd          │  runner events
      └───────────────┴────────────────┘
                      │
                      ▼
              ┌────────────┐
              │ Stream-to- │
              │ Slack      │
              │            │
              │ Status msg │
              │ edits,     │
              │ final post │
              └────────────┘
```

## Core Architectural Decisions

### 1. Control plane / data plane separation

Junior's own workspace (this repo) is the **control plane** — shared across all threads. It holds config, agent definitions, learnings, and the bot server code.

Target repos (example-backend, example-frontend) are the **data plane** — isolated per thread via git worktrees when code changes are needed.

This means:
- Learnings accumulate across all threads (shared control plane)
- Two threads editing example-backend don't collide (isolated data plane)
- Provider-native resume IDs provide per-thread conversation continuity without filesystem isolation
- Target repos' own `.claude/agents/` definitions are used in-place — not duplicated here

### 2. Session manager as the central hub

Every feature touches `ThreadSession`. It's the shared entity, like `jobs` in internal-platform.

| Field | Set by | Read by |
|---|---|---|
| `status` | Session Manager | All (guards behavior) |
| `sessionId` | Runner provider (from provider event stream) | Runner provider (for native resume) |
| `worktreePath` | Worktree Manager | Runner provider (for cwd) |
| `agentType` | Thread Commands / Agent Router | Agent Router (to load definition) |
| `systemPrompt` | Agent Router | Runner provider (Claude append-system-prompt or generated OpenCode config) |
| `pendingMessages` | Session Manager (buffer) | Session Manager (drain) |
| `verbosity` | Thread Commands | Stream-to-Slack |
| `targetRepo` | Thread Commands | Worktree Manager, Agent Router |

**Implication:** `ThreadSession` is the integration contract. Changes to its shape affect every module. Keep it stable early.

### 3. Runner providers are dumb executors

The runner boundary accepts pre-composed inputs (system prompt string, cwd path, tool config) and returns structured output (session ID, response text, normalized events). It doesn't know about Slack routing policy. This separation means:

- Agent router composes the prompt → provider adapter passes it through
- Worktree manager resolves the path → shared runtime uses it as cwd
- Stream-to-slack subscribes to normalized events → provider adapter emits them

Testing provider adapters doesn't require Slack, git, or agent definitions.

### 4. `cwd` as the configuration mechanism

Instead of passing the target repo's conventions and agent definitions via bespoke Slack state, set `cwd` to the target repo (or its worktree). Provider adapters then use that cwd consistently. Claude Code automatically reads:
- The target repo's `CLAUDE.md`
- The target repo's `.claude/agents/` definitions
- The target repo's `.claude/settings.json`

The bot also adds provider-specific wiring:
- `--append-system-prompt` (for the selected agent definition, if overriding)
- `--mcp-config` for Claude worktree-backed local tools
- generated `OPENCODE_CONFIG_CONTENT` for OpenCode prompt, permissions, support subagents, and MCP config
- native resume flags (`--resume` for Claude, `--session` for OpenCode)

This is inversion of control — the target repo configures the runner context, not the bot hardcoding every repo convention.

### 5. Provider event streams as the system boundary

Everything inside the runner process is opaque. The bot can't inspect the model's internal state, tool calls in progress, or partial file edits. The interface is provider-native events normalized into `RunnerEvent`. Claude headless emits stream-json:

```jsonl
{"type":"system","subtype":"init","session_id":"abc-123"}
{"type":"assistant","subtype":"tool_use","tool":"Bash","input":{"command":"git diff"}}
{"type":"assistant","subtype":"text","text":"I found 3 issues..."}
{"type":"result","subtype":"success","text":"Here's what I found:..."}
```

OpenCode emits JSONL from `opencode run --format json`, and Claude tmux mode tails transcript JSONL. Each adapter maps those shapes into `init`, `message`, `tool`, and `done`.

**Implication:** Provider parsers are critical. If an adapter drops an event or misparses a line, the bot loses track of what the runner did. Test adapters with captured provider output.

### 6. Provider/factory pattern at every system boundary

Four boundaries need swappable implementations:

| Boundary | Interface | Implementations |
|---|---|---|
| Session persistence | `SessionStore` | `InMemorySessionStore`, `SqliteSessionStore` |
| Slack posting | `SlackClient` | Real Bolt client, mock for tests |
| Runner spawning | `spawnRunner` / driver interfaces | OpenCode adapter, Claude headless adapter, Claude tmux driver |
| Worktree operations | `WorktreeManager` | Real git commands, mock for tests |

Factory selects the implementation at startup based on config. Consumer code only sees the interface.

### 7. Session state machine (pure function, not framework)

The session lifecycle (idle → busy → draining → idle) is a state machine with 4 transitions:

```
idle + message    → busy     (spawn process)
busy + message    → busy     (buffer message, no state change)
busy + exit(0)    → idle     (no pending) or draining (has pending)
draining          → busy     (spawn with combined buffer)
```

This is simple enough for a pure `validateTransition()` function — no XState needed. Hiring-platform learned this: XState was removed because pure validation functions did the same thing without the ceremony. Same applies here.

### 8. Event-driven internal flow (EventEmitter, not queue)

The runner handle emits normalized events as it parses provider output. Stream-to-Slack subscribes to these events. This is in-process pub/sub, not RabbitMQ.

```typescript
// runner emits
handle.onEvent((event) => { ... });

// stream-to-slack subscribes
handle.onEvent((event) => updateSlackStatus(event));
```

No external message queue needed. If the bot scales to multiple processes, add a real pub/sub boundary then.

### 9. Memory: capture cheap, consolidate offline, recall by two channels

Junior's long-term memory (`src/memory/`, `data/memory.db`, separate from the session DB) follows one invariant: **the recallable unit is the consolidated derivation, not the raw turn.** Three stages:

1. **Capture (hot path).** `MemoryIngestor` appends Slack messages / routing decisions / runner outputs as raw **source records** — cheap provenance, never returned by recall.
2. **Consolidate (offline).** A `claude -p` pass (`runConsolidationSweep` → `consolidateSession`) reads unconsolidated source records and derives **episodes** (affect-tagged log), keyed **profiles** (person/repo/situation markdown files under `memory/profiles/`), and atomic **claims** (lessons/facts), then stamps the records consolidated so they are processed exactly once.
3. **Recall (two channels, merged).** Keyed profiles are fetched verbatim by `entity_ref`; the atomic claim store is **cosine-ranked** against a locally embedded query. Recall is cosine-only — no FTS.

Two storage substrates by retrieval mode: profiles → markdown files (keyed, human-inspectable, git-trackable); claims/episodes → SQLite rows (claims carry their embedding co-located as a Float32 BLOB; episodes are not embedded). Embeddings are produced in-process by a local provider (harrier-270 ONNX) behind the same provider/factory pattern as decision #6 — affective memory never leaves for a remote API. The retired associative layer (event/edge graph, FTS, candidate-rule learning) was migrated into claims by `migrate-v3.ts` and dropped. Full design: [features/memory-system-v3.md](features/memory-system-v3.md).

## Data Flow

### Happy path: new message in new thread

```
Slack message ("!build fix auth")
  → Event Handler: filter, extract threadId, parse "!build" command
  → Session Manager: no existing session → create with agentType="build"
  → Worktree Manager: create worktree in example-backend
  → Agent Router: load example-backend/.claude/agents/build.md → compose systemPrompt
  → Runner Provider: spawn opencode/claude with the composed prompt and native resume flags
      cwd=example-backend.junior-worktrees/slack-<threadId>
  → Provider Parser: parse stdout/transcript events
      → init event: extract sessionId, store in session
      → tool events: emit to Stream-to-Slack → edit status message
      → done/final response: emit to Stream-to-Slack → post final response
  → Session Manager: set status=idle, check pendingMessages
  → Done
```

### Happy path: message while a runner is busy

```
Slack message ("also fix the tests")
  → Event Handler: extract threadId
  → Session Manager: session exists, status=busy → buffer message, react with 👀
  → [Runner finishes previous turn]
  → Session Manager: status → draining, combine buffered messages
      "[alice]: also fix the tests"
  → Runner Provider: spawn next turn with native resume id
  → [same flow as above]
```

## Module Dependency Graph

```
config ──────────────────────────────────────────────┐
                                                     │
slack/app ──── slack/events ──── slack/commands       │
                    │                  │              │
                    └──────┬───────────┘              │
                           │                          │
                    session/manager ◄─────────────────┤
                     │    │    │                       │
          ┌──────────┤    │    ├──────────┐           │
          │          │    │    │          │           │
    agents/router    │    │    │   worktree/manager   │
          │          │    │    │          │           │
          └──────────┤    │    ├──────────┘           │
                     │    │    │                       │
                 runners/index ◄──────────────────────┘
                     │    │
          ┌──────────┘    └──────────┐
     opencode/*                  claude/*
          │                           │
          └────────── runner events ──┘
                     │
              stream-to-slack
```

**Direction of dependencies:** config is depended on by all. Slack modules produce events. Session manager is the hub. Runner providers, router, and worktree manager are peers that the session manager coordinates. Stream-to-slack subscribes to runner events.

**No circular dependencies.** If module A depends on B, B must not depend on A. The session manager coordinates the other modules but doesn't import from stream-to-slack — it emits events that stream-to-slack subscribes to.

## Cross-Cutting Concerns

### Error handling

Errors at system boundaries (Slack API, runner CLI, git commands) are caught and converted to user-facing Slack messages. Internal errors (state machine violations, parse failures) are logged but don't crash the bot.

### Logging

Console.log for MVP. Structured logging (pino) for production. Every log line includes `threadId` for correlation.

### Testing strategy

| Layer | Test approach |
|---|---|
| Provider parsers | Unit tests with captured Claude/OpenCode/tmux transcript samples |
| Session state machine | Unit tests — pure function, no I/O |
| Agent loader | Unit tests — read real .md files from fixtures |
| Runner adapters | Integration tests — mock child_process or use real CLI smoke tests |
| Slack handler | Integration tests — mock Bolt client |
| End-to-end | Manual — send Slack messages, verify responses |

Mock at the four system boundaries (Slack, runner CLI, git, persistence). Everything internal is tested with real code.

## Patterns from Reference Projects

Patterns carried forward from example-backend and internal-platform that apply here:

| Pattern | Source | How it applies |
|---|---|---|
| Provider/factory for infrastructure | Both projects | Session store, Slack client, spawner, worktree ops |
| Pure validation functions over state machine frameworks | internal-platform (removed XState) | Session state transitions as pure functions |
| Infrastructure emerges from usage | internal-platform | Build shared abstractions when the second module needs them, not before |
| Mock at boundaries, not internals | example-backend rule #16 | Four system boundaries identified above |
| Feature docs as code indexes | Both projects | `docs/code_index/*.md` created as modules are built |
| Checkpoint = commit | Both projects | Every working state gets committed |
| Two clean passes before done | example-backend | Self-verification runs twice |
