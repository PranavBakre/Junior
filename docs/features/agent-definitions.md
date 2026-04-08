# Agent Definitions

## Problem

The spawned Claude Code instances need personality and context. A bare `claude -p "fix auth"` with no system prompt produces generic output that doesn't know the repo conventions, doesn't follow the coding rules, doesn't have the right reviewer style. Agent definitions are the markdown files that turn generic Claude into Scotty (backend engineer), Bones (code reviewer), or Uhura (frontend engineer).

**Who has this problem:** Every thread that uses an agent type.
**What happens today:** example-backend already has 10+ agent definitions in `.claude/agents/`. They work when running Claude Code directly. But the Slack bot needs to load, compose, and inject them.
**Painful part:** Agent definitions for Example Org repos live in THOSE repos. Junior should not duplicate them. But junior needs its own agents for: (a) generic tasks not tied to a specific repo, (b) developing the bot itself, (c) fallback when target repo has no matching agent.
**"Finally" moment:** `/build` in a example-backend thread → loads example-backend's build.md agent. `/review` in a junior thread → loads junior's own review.md agent. No duplication. No drift.

## Full Vision

**Junior's own agents (`.claude/agents/` in this repo):**

| Agent | Purpose |
|---|---|
| `build.md` | Generic backend builder — for junior itself and repos without their own build agent |
| `review.md` | Code reviewer — Bones equivalent. 6-pass methodology, inline GitHub comments |
| `frontend.md` | Generic frontend builder — for repos without their own frontend agent |
| `architect.md` | System architect — specs, data models, state machines |
| `pm.md` | Product manager — scoping, iterations, scope cuts |
| `common/building-philosophy.md` | Shared preamble for all builder agents |

**Loading priority:**
1. Target repo's `.claude/agents/<type>.md` (e.g., example-backend has its own build.md)
2. Junior's `.claude/agents/<type>.md` (fallback)
3. No agent (generic Claude with just CLAUDE.md)

**What already exists in example-backend (DON'T duplicate):**
- build.md, domain-eng.md, design-fe.md, content.md, pm.md, audit.md, retention.md, strategy.md, provocateur.md, domain-ops.md
- common/building-philosophy.md

## Dependencies

- Agent Router (feature: [agent-routing.md](agent-routing.md)) — loads and injects these
- example-backend `.claude/agents/` — existing definitions (read-only reference)

## Iterations

### Iteration 0: Review agent (~30 min)

The most immediately useful agent. PR review is the most common async task.

**What it adds:** `junior/.claude/agents/review.md` — code reviewer agent definition.
- Identity: Bones (🩺), thorough but not pedantic
- 6-pass methodology: logic, safety, product thinking, query performance, consistency, surface
- Always posts inline GitHub comments (not Slack summaries)
- Reads the full diff before forming opinions
- Severity levels: blocker, warning, nit
- Completion criteria: two consecutive clean passes before approving

**Test:** Load the agent definition. Inject as system prompt. Give Claude a PR diff. Output should be structured review with severity-tagged inline comments.
**Defers:** Other agents, common preamble.

### Iteration 1: Build agent (~30 min)

Generic backend builder for repos that don't have their own.

**What it adds:** `junior/.claude/agents/build.md` — backend engineer agent definition.
- Identity: Scotty (🔧), pragmatic, ships working code
- Context loading checklist: read CLAUDE.md, read feature doc, check git log
- Architecture awareness: route → service → CRUD layering
- Self-verification: read modified files, typecheck, run tests, two clean passes
- Anti-patterns: query outside services, skipping feature doc, gold-plating
- Session handoff: write summary of what was done, what's pending, what's fragile

**Test:** Load the agent definition. It should be generic enough to work on any Node/TS backend, not Example Org-specific (example-backend has its own).
**Defers:** Frontend agent, architect, pm.

### Iteration 2: Frontend agent and common preamble (~30 min)

**What it adds:**
- `junior/.claude/agents/frontend.md` — Uhura (✨), pixel-perfect, design-aware
  - Knows React, TypeScript, Tailwind, component patterns
  - Checks responsive behavior, loading states, error states, empty states
  - Self-verification: visual check, typecheck, accessibility basics
- `junior/.claude/agents/common/building-philosophy.md` — shared preamble
  - Design for swappability
  - Pure functions over framework ceremony
  - Test against real infrastructure
  - Small testable chunks, checkpoint = commit

**Test:** Load frontend agent with common preamble prepended. Prompt content reflects both.
**Defers:** Architect, pm agents.

### Iteration 3: Architect and PM agents (~30 min)

**What it adds:**
- `junior/.claude/agents/architect.md` — Oracle (🔮), systems thinker
  - Writes specs, not code
  - Data models, state machines, API contracts
  - "If a design needs a paragraph to explain, it's too complex"
  - Output format: iteration-based spec docs (following ideation workflow)
- `junior/.claude/agents/pm.md` — product manager
  - Iteration planning, scope cuts, "smallest version a member would use"
  - Questions before conclusions
  - Output format: feature doc following ideation workflow template

**Test:** Architect agent given a feature request → produces a spec with data model and state machine. PM agent → produces iteration plan with test criteria and deferrals.
**Defers:** Audit, content, domain-specific agents (those live in target repos).

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Hardcoded agent prompts in testing | Iteration 0+ (file-based) |
| No common preamble | Iteration 2 |
| Only 5 agent types | Post-MVP (add as needed) |

## Cut List (true v2)

- Agent versioning (track which version of an agent definition was used per session)
- Agent A/B testing (run same prompt with two agents, compare output)
- Agent composition (combine two agents for a thread: build + review)
- Community agent registry
- Agent performance tracking (which agents produce better outcomes)
