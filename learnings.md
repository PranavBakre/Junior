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

## Known Gaps

- No source code yet — CLAUDE.md is written against the design doc, not working code. Rules and structure sections need updating as implementation begins.
- Open questions from the feature doc (stream-json schema, `--resume` + `--worktree` interaction, session locking) are unresolved and will affect implementation choices.
- Agent definitions (`.claude/agents/`) not yet written — the mapping from OpenClaw agents to Claude Code agents is documented but not implemented.
