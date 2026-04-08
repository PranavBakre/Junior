# Learnings

## Engineering Principles

### Verify access before assuming a resource exists
Tools that work with one identity may fail silently or return 404 with another. Always confirm which auth context is active before debugging "not found" errors.
- `gh` was authenticated as `pranav-example-org` (org account), not `PranavBakre` (personal). The private repo was invisible — looked like it didn't exist.
- Searched public repos, org repos, and broad GitHub search before checking `gh auth status`. Would have saved 3 rounds of failed API calls.

### Study the system you're replacing before designing the new one
Migration projects carry forward patterns, not just features. Reading the predecessor's architecture reveals which decisions were load-bearing vs incidental.
- The openclaw-agents repo had SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md — each serving a distinct role. Understanding which responsibilities map to CLAUDE.md vs `.claude/` config vs hooks prevented a flat copy-paste.
- Sub-agent dispatch rules (share context, define "done", one job per agent) were hard-won lessons in the old system — carried forward as critical rules rather than rediscovered.

### Map capabilities by function, not by name
When migrating between platforms, the 1:1 name mapping is misleading. Group by what the capability *does*, then find the right primitive in the new system.
- OpenClaw's `slack` skill → becomes the bot server itself (not a Claude Code skill)
- OpenClaw's `coding-agent` skill → becomes `claude -p --worktree` spawning logic built into the server
- OpenClaw's SOUL.md personality system → absorbed into `.claude/agents/*.md` frontmatter + prompt body
- OpenClaw's heartbeat polling → replaced by Claude Code hooks + cron (different mechanism, same function)
- 6 OpenClaw concepts (skills, agents, channels, heartbeats, SOUL/AGENTS/TOOLS files, process monitoring) collapsed into 3 Claude Code concepts (agents, hooks, CLI flags)

## Technical Learnings

### OpenClaw config files contain secrets in plaintext
`~/.openclaw/openclaw.json` stores Telegram bot tokens, Slack bot/app tokens, and API keys (OpenAI, Google) directly in the JSON config. No vault, no env var indirection. When reading this file programmatically or in an AI context, the secrets enter the context window. The new system should use env vars or a secrets manager — never inline tokens in config files that agents read.

### Distinguish the orchestrator's state from the work it orchestrates
Isolation strategies should match what needs isolating. Applying the same isolation boundary to everything conflates two different concerns.
- Initial design used worktree-per-thread for everything — including Junior's own workspace (CLAUDE.md, learnings, agents). That would silo learnings so no thread benefits from another's discoveries.
- The thing that needs isolation is the *target repo* (example-backend, example-frontend) when concurrent threads edit code. The orchestrator's own state (learnings, config, agent definitions) should be shared so knowledge accumulates.
- `--resume` with session IDs gives per-thread conversation continuity without requiring filesystem isolation for the orchestrator itself.

### Don't duplicate agent definitions across repos
When the orchestrator spawns Claude Code with `cwd` set to a target repo, that repo's own `.claude/agents/` definitions are already available. Duplicating them into the orchestrator's repo creates a sync problem — two copies drift apart silently.
- Example Org-specific agents (domain-eng, design-fe, content, etc.) already exist in example-backend's `.claude/agents/`. The bot should reference them by spawning with the right `cwd`, not by copying them into junior.
- Only agents that are *about the orchestrator itself* (bot-dev, generic build/review/frontend) belong in junior's `.claude/agents/`.

### Feature docs decompose naturally along process boundaries
When breaking a system into feature docs, the right cut points are where one process talks to another — not where code lives in the filesystem.
- The session manager, Claude spawner, and stream parser could live in one "Claude integration" doc. But they have different failure modes, different iteration cadences, and different test strategies. Separating them made each doc's iterations small and independently testable.
- Conversely, thread commands and agent routing could be separate docs but share the same "message arrives, pick an action" flow. They cross-reference each other instead of merging.
- 11 feature docs emerged from 6 conceptual features. The extras (process-lifecycle, thread-commands, agent-definitions) appeared when a single doc's iteration count exceeded 5 — a signal that it was actually two features sharing a name.

### "How do you know it works?" is the real decomposition tool
Writing test criteria for each iteration forces you to split things that look like one feature but aren't. If two things in the same iteration require different test strategies, they're different iterations.
- Stream-json parsing and arg building were initially one iteration in claude-spawner. But parsing is tested with mock stdout data, arg building is tested by inspecting the generated command. Different inputs, different assertions — split them.
- Session cleanup and worktree cleanup were initially one iteration. But session cleanup is tested with time-based stale detection, worktree cleanup requires checking git state. Split.

### An iteration plan template prevents scope drift more than discipline does
The ideation workflow's format (problem, full vision, iterations with test + defer, shortcuts, cut list) forced completeness that free-form writing wouldn't. Specifically: the "cut list" section names things you're NOT building, which prevents them from sneaking into iterations later. The "defers" per iteration prevent gold-plating within a single iteration. Structure > willpower for scope control.

## Known Gaps

- No source code yet — CLAUDE.md is written against the design doc, not working code. Rules and structure sections need updating as implementation begins.
- Open questions from the feature doc (stream-json schema, `--resume` + `--worktree` interaction, session locking) are unresolved and will affect implementation choices.
- Agent definitions (`.claude/agents/`) not yet written — the mapping from OpenClaw agents to Claude Code agents is documented but not implemented.
- Build order not yet determined — feature docs have cross-dependencies (session-management depends on claude-spawner depends on stream parser). Need a topological sort before starting implementation.
