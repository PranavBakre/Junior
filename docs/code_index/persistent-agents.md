# Code Index: Persistent Agents & Dispatch

Multi-agent dispatch layer: registry of agent slack identities, orchestrator/worker classification, dispatch-allow rules, and the universal message router that parses `!<agent>` and `!devserver` directives and routes each to the right session slice.

## Code Index

### src/support

| Symbol | File | Purpose |
|---|---|---|
| `AGENT_IDENTITIES` | `agents.ts` | Mutable registry of `agentName → { username, iconEmoji }`. Core agents (`default`, `lead`, `reproducer`, `thinker`, `review`, `echo`) seeded in code. |
| `registerAgentIdentity(name, identity)` | `agents.ts` | Add an overlay agent identity. Refuses to overwrite existing entries. |
| `loadOverlayIdentities(dirPath)` | `agents.ts` | Scan `.claude/agents-org/*.md` and register identities for agents with both `username` + `iconEmoji` frontmatter. |
| `isOrchestratorAgent(name)` | `agents.ts` | `name ∈ {lead, default, junior}`. Orchestrators may dispatch any worker. |
| `isPersistentAgent(name)` | `agents.ts` | Membership check in `AGENT_IDENTITIES`. |
| `identityForAgent(name)` | `agents.ts` | Lookup; undefined if not registered. |
| `agentForUsername(username)` | `agents.ts` | Reverse lookup, used to classify self-bot posts. |
| `WORKER_DISPATCH_ALLOW` | `agents.ts` | Worker → worker dispatch exceptions (e.g. `thinker → {review, reproducer}`). |
| `workerMayDispatch(src, target)` | `agents.ts` | Gate for worker self-bot directives. |
| `dispatchableAgentsFor(name)` | `agents.ts` | Returns allowed dispatch targets for an agent. |
| `buildDispatchAllowBlock(name)` | `agents.ts` | `<dispatch-allow>` system-prompt block injected into every agent. |
| `AgentDispatcher` | `router.ts` | Universal Slack-message entry point; routes to single-session, lead, persistent-agent, or `!devserver` handler. |
| `parseAgentDirectives(text)` | `router.ts` | Extract `!<persistent-agent> ...` lines from message text. |
| `parseDevserverDirective(line)` | `router.ts` | Parse one `!devserver <branch> [repo]` / `status` / `kill <repo>` line. |

### Types

| Type | File | Purpose |
|---|---|---|
| `AgentDirective` | `router.ts` | `{ agentName, prompt, line }` |
| `DevserverDirective` | `router.ts` | Union: `acquire \| status \| kill \| malformed` |

## Dispatch Flow

```
AgentDispatcher.handleMessage(event)
  │
  ├── findDevserverDirective(text)?     → handleDevserverDirective (acquire/status/kill)
  │
  ├── parseAgentDirectives(text)        + reconstruct from event.command if a persistent-agent name
  │
  ├── No directives?
  │     ├── self-bot orchestrator/unknown → drop (loop guard)
  │     ├── self-bot worker in support     → handleLeadMessage (forward to lead)
  │     ├── session.defaultAgent set       → lead or junior per override
  │     └── else                           → handleLeadMessage (support) or handleMessage (other)
  │
  └── Has directives?
        ├── worker self-bot: filter by workerMayDispatch; if empty → forward to lead
        └── handleAgentMessage(event, agentName) per directive (parallel by agent, sequential within)
```

## Key Concepts

### Orchestrator vs Worker

Orchestrators (`lead`, `default`, `junior`) may emit any `!<agent>` directive. Workers may emit only entries in `WORKER_DISPATCH_ALLOW` (currently `thinker → {review, reproducer}`). Disallowed worker directives are stripped and the message is re-routed to lead as plain text.

### Self-bot routing

Junior's app subscribes to its own posts (`ignoreSelf: false` in `slack/app.ts`) so lead can hand off via posted directives. `events.ts` filters incidental self-bot chatter; only messages with a `!<persistent-agent>` directive (or in an auto-trigger channel) reach the dispatcher.

### `!devserver` (inline handler)

Handled by `AgentDispatcher`, not by spawning Claude. `acquire` calls `DevServerQueue.acquire(repo, branch, threadId)`, posts ready/queued status, then sleeps `slotTimeoutMs` (10 min) before auto-releasing. `status` reads queue depth; `kill` calls `DevServerQueue.kill`.

### Overlay identities

Private/org agents register slack identities via frontmatter (`username:` + `iconEmoji:`) in `.claude/agents-org/*.md`. Loaded at startup by `loadOverlayIdentities`. Core identities can't be overwritten — overlay can only add new names.

## Dependencies

- **Uses**: `agents/loader` (frontmatter parsing), `session/manager` (handleMessage / handleLeadMessage / handleAgentMessage), `lifecycle/dev-server-queue`, `@slack/web-api`
- **Used by**: `index.ts` (constructs `AgentDispatcher` with support-channel set), `session/manager.ts` (uses `buildDispatchAllowBlock` + `identityForAgent` when composing system prompts)
