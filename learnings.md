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

### Review your own docs against the platform's constraints, not just the design's logic
A design can be internally consistent and still wrong because it violates platform constraints the author didn't check.
- All feature docs used `/build`, `/reset`, `/status` as command syntax. Slack intercepts any message starting with `/` as a slash command — users literally cannot type `/build fix auth` in Slack. Switched to `!` prefix across 10 files.
- The spawner doc had iteration 2 loading agent definitions — but that's the router's responsibility. The spawner should be a dumb executor that accepts a pre-composed prompt. Internal consistency (each module does one thing) caught this on review.
- Agent routing had a "suggest with a chatty Slack reply" pattern that violated the no-narration principle already documented in SOUL.md. Cross-referencing behavioral rules against feature designs caught it.

### Parallel worktree agents merge cleanly when they touch different directories
Two agents working in isolated worktrees on non-overlapping directories (slack/ and claude/) merged into main with zero conflicts — one fast-forward, one clean 3-way merge. The precondition: scaffold the shared foundation first (types, config, directory structure), then branch.
- Project-setup created the shared types (ThreadSession, StreamEvent, Config) that both agents imported. Neither agent needed to modify the other's types.
- The only shared file both agents touched was index.ts — but the slack agent's change was a complete rewrite (echo bot → modular wiring), while the claude agent didn't touch it. No conflict.
- Key: the build order (setup → independent features → integration features) naturally prevents conflicts. Features that depend on each other can't be parallelized anyway.

### Agents that modify shared files need worktree isolation enforced, not optional
When multiple agents run in parallel and some modify the same file (index.ts, types.ts), agents that commit directly to main create a race condition. In this session, some agents used worktree branches while others committed straight to main — depending on whether the worktree was auto-cleaned before or after committing.
- The worktree-manager agent committed to its worktree branch, which got force-deleted during cleanup before being merged. Had to recover with `git cherry-pick` from the dangling commit.
- Thread-commands and process-lifecycle agents committed directly to main sequentially (no conflict because they ran at different times), but this was luck — if they'd both been writing index.ts simultaneously, one would have stomped the other.
- Lesson: for agents that touch shared files (index.ts is the main integration point), ensure the worktree branch survives until explicit merge. For agents that only create new files in new directories, direct-to-main is safe.

### Sub-agent permission boundaries must be anticipated in the prompt
Sub-agents inherit the parent's permission mode but may still be blocked by per-tool allowlists or hook-based gates. If the agent's entire job is creating files in a new directory, a Write permission denial halts it completely with no fallback.
- The agent-definitions agent was tasked with creating 6 markdown files in `.claude/agents/`. Both Write and Bash were denied. The agent couldn't complete any of its work and returned a permission request instead of results.
- Fix: either pre-create the directory structure before spawning, or do file-creation tasks in the main context where permissions are already granted. Reserve sub-agents for work that uses tools they're known to have access to.

### Multi-agent builds need a post-merge audit pass — typecheck alone isn't enough
When 8 agents build 10 modules independently, they each typecheck in isolation. But the integration points (index.ts wiring, callback signatures, module A calling module B) only get tested when everything is merged. Typecheck catches type mismatches but not logic gaps.
- 5 blockers survived typecheck: worktree manager never instantiated, timeout never applied, health/cleanup never scheduled, command responses going to console instead of Slack, bot mention not stripped from app_mention events.
- These are all wiring gaps — each module is correct in isolation but nobody connected them. The audit found them by tracing call paths from index.ts through every module.
- Lesson: after any multi-agent build wave, do a manual audit of the integration file (index.ts) and the hub module (session/manager.ts) before declaring done. Read every callback assignment and ask "does this actually reach the user?"

### Architecture audits catch a different class of bugs than functional audits
The first audit (post-build) found 11 wiring gaps — features built but not connected. The architecture audit found 7 convention violations — features connected but not following the design. Zero overlap between the two.
- Post-build audit catches: "this module exists but nobody calls it." Architecture audit catches: "this module is called but violates decision 4 (cwd should point to target repo, not junior)."
- The spawner cwd fallback was the best example: code worked, tests passed, but `process.cwd()` violated the control plane / data plane separation. A review agent caught it because it was checking against the architecture doc, not against functional behavior.
- Two audit types, two classes of bugs. Run both after multi-agent builds.

## Known Gaps

- No .env with real Slack tokens — bot can't be tested end-to-end until tokens are provided.
- 140 unit tests passing but no integration/e2e test with real Slack + Claude yet.
