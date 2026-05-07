# Architecture

System architecture for junior — the Slack bot that orchestrates Claude Code sessions.

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Bun | Built-in TS, .env, faster child_process spawning. Fallback to Node+tsx if Bun has issues. |
| Slack SDK | @slack/bolt (Socket Mode) | Official SDK. Socket Mode = no public URL needed, works from a laptop. |
| Language | TypeScript (strict, ESM) | Type safety across the session state machine and stream parser. |
| Persistence (MVP) | In-memory Map | Good enough for single-process bot. |
| Persistence (prod) | Redis | Survives restarts. TTL-based session cleanup. Provider/factory pattern. |
| CLI | Claude Code (`claude -p`) | Max subscription auth. Short-lived processes. Stream-json output. |

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
│   Agent    │  │  Worktree  │  │   Claude   │
│   Router   │  │  Manager   │  │  Spawner   │
│            │  │            │  │            │
│ Load .md   │  │ git work-  │  │ spawn      │
│ from target│  │ tree in    │  │ claude -p  │
│ repo's     │  │ TARGET     │  │ parse      │
│ .claude/   │  │ repos      │  │ stream-json│
│ agents/    │  │ (not here) │  │            │
└─────┬──────┘  └─────┬──────┘  └──────┬─────┘
      │               │                │
      │   systemPrompt│   cwd          │  stdout events
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
- `--resume` provides per-thread conversation continuity without filesystem isolation
- Target repos' own `.claude/agents/` definitions are used in-place — not duplicated here

### 2. Session manager as the central hub

Every feature touches `ThreadSession`. It's the shared entity, like `jobs` in internal-platform.

| Field | Set by | Read by |
|---|---|---|
| `status` | Session Manager | All (guards behavior) |
| `sessionId` | Claude Spawner (from stream-json init event) | Claude Spawner (for --resume) |
| `worktreePath` | Worktree Manager | Claude Spawner (for cwd) |
| `agentType` | Thread Commands / Agent Router | Agent Router (to load definition) |
| `systemPrompt` | Agent Router | Claude Spawner (for --append-system-prompt) |
| `pendingMessages` | Session Manager (buffer) | Session Manager (drain) |
| `verbosity` | Thread Commands | Stream-to-Slack |
| `targetRepo` | Thread Commands | Worktree Manager, Agent Router |

**Implication:** `ThreadSession` is the integration contract. Changes to its shape affect every module. Keep it stable early.

### 3. Spawner is a dumb executor

The spawner accepts pre-composed inputs (system prompt string, cwd path, tool config) and returns structured output (session ID, response text, events). It doesn't know about agents, worktrees, or Slack. This separation means:

- Agent router composes the prompt → spawner passes it through
- Worktree manager resolves the path → spawner uses it as cwd
- Stream-to-slack subscribes to events → spawner emits them

Testing the spawner doesn't require Slack, git, or agent definitions.

### 4. `cwd` as the configuration mechanism

Instead of passing the target repo's conventions, agent definitions, and CLAUDE.md via flags, set `cwd` to the target repo (or its worktree). Claude Code automatically reads:
- The target repo's `CLAUDE.md`
- The target repo's `.claude/agents/` definitions
- The target repo's `.claude/settings.json`

The bot only needs to add:
- `--append-system-prompt` (for the selected agent definition, if overriding)
- `--mcp-config` (for per-thread tool scoping)
- `--resume` (for conversation continuity)

This is inversion of control — the target repo configures Claude, not the bot.

### 5. Stream-json as the system boundary

Everything inside the Claude Code process is opaque. The bot can't inspect Claude's internal state, tool calls in progress, or partial file edits. The only interface is the stream-json stdout:

```jsonl
{"type":"system","subtype":"init","session_id":"abc-123"}
{"type":"assistant","subtype":"tool_use","tool":"Bash","input":{"command":"git diff"}}
{"type":"assistant","subtype":"text","text":"I found 3 issues..."}
{"type":"result","subtype":"success","text":"Here's what I found:..."}
```

**Implication:** The stream parser is the most critical piece to get right. If it drops an event or misparses a line, the bot loses track of what Claude did. Test it thoroughly with real stream-json output samples.

### 6. Provider/factory pattern at every system boundary

Four boundaries need swappable implementations:

| Boundary | Interface | Implementations |
|---|---|---|
| Session persistence | `SessionStore` | `InMemorySessionStore`, `RedisSessionStore` |
| Slack posting | `SlackClient` | Real Bolt client, mock for tests |
| Claude spawning | `ClaudeSpawner` | Real child_process, mock for tests |
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

The spawner emits events as it parses stream-json. Stream-to-Slack subscribes to these events. This is in-process pub/sub — an EventEmitter, not RabbitMQ.

```typescript
// spawner emits
spawner.on("tool_use", (event) => { ... });
spawner.on("result", (event) => { ... });

// stream-to-slack subscribes
spawner.on("tool_use", (event) => updateSlackStatus(event));
spawner.on("result", (event) => postFinalResponse(event));
```

No external message queue needed. If the bot scales to multiple processes, consider Redis pub/sub — but that's post-MVP.

## Data Flow

### Happy path: new message in new thread

```
Slack message ("!build fix auth")
  → Event Handler: filter, extract threadId, parse "!build" command
  → Session Manager: no existing session → create with agentType="build"
  → Worktree Manager: create worktree in example-backend
  → Agent Router: load example-backend/.claude/agents/build.md → compose systemPrompt
  → Claude Spawner: spawn claude -p "fix auth" --resume --append-system-prompt "..." 
      cwd=example-backend.junior-worktrees/slack-<threadId>
  → Stream Parser: parse stdout events
      → init event: extract sessionId, store in session
      → tool_use events: emit to Stream-to-Slack → edit status message
      → result event: emit to Stream-to-Slack → post final response
  → Session Manager: set status=idle, check pendingMessages
  → Done
```

### Happy path: message while Claude is busy

```
Slack message ("also fix the tests")
  → Event Handler: extract threadId
  → Session Manager: session exists, status=busy → buffer message, react with 👀
  → [Claude finishes previous turn]
  → Session Manager: status → draining, combine buffered messages
      "[alice]: also fix the tests"
  → Claude Spawner: spawn claude -p "<combined>" --resume <sessionId>
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
                 claude/spawner ◄──────────────────────┘
                     │    │
              claude/parser
                     │
              stream-to-slack
```

**Direction of dependencies:** config is depended on by all. Slack modules produce events. Session manager is the hub. Spawner, router, and worktree manager are peers that the session manager coordinates. Stream-to-slack subscribes to spawner events.

**No circular dependencies.** If module A depends on B, B must not depend on A. The session manager coordinates the other modules but doesn't import from stream-to-slack — it emits events that stream-to-slack subscribes to.

## Cross-Cutting Concerns

### Error handling

Errors at system boundaries (Slack API, Claude CLI, git commands) are caught and converted to user-facing Slack messages. Internal errors (state machine violations, parse failures) are logged but don't crash the bot.

### Logging

Console.log for MVP. Structured logging (pino) for production. Every log line includes `threadId` for correlation.

### Testing strategy

| Layer | Test approach |
|---|---|
| Stream parser | Unit tests with captured stream-json samples |
| Session state machine | Unit tests — pure function, no I/O |
| Agent loader | Unit tests — read real .md files from fixtures |
| Spawner | Integration tests — mock child_process or use real Claude with simple prompts |
| Slack handler | Integration tests — mock Bolt client |
| End-to-end | Manual — send Slack messages, verify responses |

Mock at the four system boundaries (Slack, Claude, git, Redis). Everything internal is tested with real code.

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
