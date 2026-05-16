# Agent Routing

## Problem

Different Slack threads need different Claude Code personalities. A thread asking Claude to build a backend feature needs the `build` agent definition (knows the monorepo architecture, CRUD conventions, auth middleware). A thread asking for a PR review needs the `review` agent (diagnostic, posts inline GitHub comments). The bot needs to pick the right agent definition and inject it into the Claude process.

**Who has this problem:** The session manager — it needs to know which agent to use for each thread.
**What happens today:** Nothing — all threads would get the same generic Claude.
**Painful part:** Agent definitions live in the TARGET repo's `.claude/agents/` (not in junior). The bot needs to read them from the right repo, compose them with thread-specific context, and pass them to Claude. Also: when should the agent type change mid-thread?
**"Finally" moment:** `!build fix the auth middleware` → Claude responds like a senior backend engineer who knows the Example Org monorepo. `!review PR #4900` → Claude responds like a thorough code reviewer who posts inline GitHub comments.

## Full Vision

- Command selects agent type: `!build`, `!frontend`, `!review`, `!architect`, `!pm`, `!audit`, `!reproducer`, `!thinker`, …
- Agent definitions resolved across a **layered search chain** — first match wins:
  1. Target repo's `.claude/agents/<type>.md`
  2. Private org overlay's `<orgAgentsDir>/<type>.md` (e.g. `agents-org/`, a gitignored or submodule-mounted private repo)
  3. Junior's own `.claude/agents/<type>.md` (fallback)
- Agent definition injected via `--append-system-prompt`
- Agent type persists across turns in a thread; can be changed mid-thread with a new command
- Lead and the default `@junior` path also flow through this composition (`lead.md` and `default.md` are explicit public fallback agents).
- Common preamble is selected by each agent's `common:` frontmatter profile:
  - `core.md` is the tiny always-on operating contract.
  - Target repo common is checked first per selected file; missing selected files fall back individually to Junior's public common.
  - Org overlay common is additive, but only for the selected filenames. Junior no longer appends every `common/*.md` to every agent.
- **Per-agent context profile** (frontmatter flags) lets lightweight task agents opt out of preamble blocks (`identity`, `slack`, `workspace`, `threadHistory`, `agentState`). Defaults are all-true; missing or invalid flags preserve the heavy preamble.

## Dependencies

- Session Manager (feature: [session-management.md](session-management.md)) — tracks agent type per session
- Claude Spawner (feature: [claude-spawner.md](claude-spawner.md)) — accepts system prompt
- Target repo `.claude/agents/` directories (already exist in example-backend)

## How Agent Definitions Work

Agent definitions are markdown files with YAML frontmatter:

```markdown
---
name: build
description: Senior backend engineer for the Example Org monorepo.
tools: Read, Edit, Write, Bash, Grep, Glob, Agent
common: core,building-philosophy
---

# build — Backend Engineer

Role: A senior engineer who knows the Example Org monorepo architecture...
[full agent prompt]
```

The bot:
1. Reads the `.md` file from the target repo
2. Strips frontmatter, extracts `tools`, context flags, and `common:`
3. Composes selected common files + markdown body as the system prompt

## Iterations

### Iteration 0: Hardcoded agent map (~15 min)

Prove the wiring works with a hardcoded map of agent type → system prompt string.

**What it adds:** Map of `{ build: "You are a backend engineer...", review: "You are a code reviewer..." }`. Session manager looks up agent type, passes prompt string to spawner's `--append-system-prompt`.
**Test:** `!build hello` → Claude's response reflects backend engineer persona. `!review hello` → Claude's response reflects reviewer persona.
**Defers:** Reading from files, target repo lookup, frontmatter parsing, common preamble.

### Iteration 1: File-based agent loading (~30 min)

Load agent definitions from the filesystem instead of hardcoded strings.

**What it adds:**
- `loadAgentDefinition(repoPath, agentType)` → reads `<repoPath>/.claude/agents/<agentType>.md`
- Parse YAML frontmatter: extract `name`, `description`, `tools`
- Return `{ prompt: string, allowedTools: string[], description: string }`
- Fallback: if agent file doesn't exist in target repo, check `junior/.claude/agents/`
- If neither exists, return null (use generic Claude)

**Test:** Point at example-backend, load "build" → get the full build agent prompt. Load "nonexistent" → returns null. Create a local fallback in junior → fallback works.
**Defers:** Common preamble, caching, agent type validation.

### Iteration 2: Common preamble (~20 min)

Load and prepend the common preamble that all agents share.

**What it adds:**
- Check for `<repoPath>/.claude/agents/common/` directory
- Load only common files named by the agent's `common:` profile and prepend them to the agent prompt
- Order: `core` first, then profile order, with per-file fallback from target repo common to Junior public common, then agent-specific prompt
- example-backend already has `common/building-philosophy.md` — this gets loaded for all example-backend agents

**Test:** Load "build" agent for example-backend → prompt starts with building-philosophy.md content, then build.md content.
**Defers:** Caching, hot reload, additive overlay (see Iteration 5).

### Iteration 3: Agent type from message context (~30 min)

Auto-detect agent type when no `!command` is given, based on message content.

**What it adds:**
- If message mentions "PR", "review", "diff" → auto-assign review agent
- If message mentions "fix", "build", "implement", "add" → auto-assign build agent
- If message mentions "design", "spec", "architect" → auto-assign architect agent
- Auto-assign silently — no "I'm using the review agent" announcement. The response style makes it obvious which agent is active.
- User can override with explicit `!build` or `!review` command at any point

**Test:** "Can you review PR #4900?" → review agent assigned silently, response reads like a code reviewer. "Fix the auth bug" → build agent assigned. User sends `!review` after auto-assign → overrides.
**Defers:** ML-based classification, per-channel defaults.

### Iteration 4: MCP config per agent (~30 min)

Different agent types get different MCP server configurations.

**What it adds:**
- `generateMcpConfig(agentType, threadId)` → writes a temp JSON file
- Build agent: full MCP config (DB access, docs, etc.)
- Review agent: read-only MCP config (docs only, no DB writes)
- Generic: minimal or no MCP config
- Pass via `--mcp-config <path>` to Claude spawner
- Clean up temp config files on session cleanup

**Test:** Build session → MCP config includes DB server. Review session → MCP config excludes DB write tools. Temp files cleaned up after session ends.
**Defers:** Dynamic MCP config updates mid-session.

### Iteration 5: Private org overlay + per-agent context profile (~1 hr)

Separate the public Junior repo from org-specific specifics, and let lightweight agents opt out of the heavy preamble.

**What it adds:**
- `AgentRouter` accepts a third constructor arg `orgAgentsDir` (e.g. `agents-org/`) — a gitignored or submodule-mounted private repo.
- `resolveAgent`: search order becomes target repo → org overlay → public fallback (first match wins).
- `composeSystemPrompt`: org overlay's `common/*.md` is appended **additively** after the public/target common — so org-wide invariants (credential paths, merge protocol, infra URLs) reach every agent regardless of which repo's common loaded first.
- `composeSystemPrompt` also now returns the common preamble alone when no agent definition resolves — covers the default `@junior` path so it picks up the same invariants.
- Per-agent **context profile** via frontmatter dot-notation flags: `context.identity`, `context.slack`, `context.workspace`, `context.threadHistory`, `context.agentState`. Each gates the corresponding block in `buildPromptPreamble`. Defaults are all-true; missing/invalid flags preserve the heavy preamble (safe-but-heavy).
- `lead`/`default` agentName branches in `buildRunSession` set `agentType` so they participate in the new compose path (previously short-circuited).

**Test:** Six-scenario load-path matrix (default-no-target, default-target-with-no-common, default-target-with-common, lead variants, worker-with-target) confirms overlay common reaches every agent; public common reaches all agents except those whose target repo has its own common; agent body resolves correctly per the search-chain order.
**Defers:** Caching, hot reload of overlay files, additive merging across all three tiers (currently target-or-fallback is still exclusive).

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Hardcoded agent prompts | Iteration 1 (file-based) |
| No auto-detection | Iteration 3 |
| No MCP config | Iteration 4 |
| Single tier of agent/common files | Iteration 5 (overlay) |
| All agents get the full preamble | Iteration 5 (context profile) |
| No caching of agent definitions | Post-MVP |

## Cut List (true v2)

- Agent marketplace (install community agent definitions)
- Agent chaining (review agent hands off to build agent in same thread)
- Agent voting (multiple agents review, majority wins)
- Custom agent creation via Slack (`!create-agent` → interactive form)
- Per-user agent preferences (alice always gets verbose review, bob gets terse)
