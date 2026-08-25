# Agent Definitions

> **Current status (2026-08-15):** Shipped. `AgentRouter` and the trusted
> catalog load public, private-overlay, and target-repository definitions at
> runtime; the iteration sections below are retained as implementation history
> and future cut-list context.

## Problem

The spawned Claude Code instances need personality and context. A bare `claude -p "fix auth"` with no system prompt produces generic output that doesn't know the repo conventions, doesn't follow the coding rules, doesn't have the right reviewer style. Agent definitions are the markdown files that turn generic Claude into Scotty (backend engineer), Bones (code reviewer), or Uhura (frontend engineer).

**Who has this problem:** Every thread that uses an agent type.
**Current behavior:** Junior loads target-repository definitions when present,
then the private `agents-org` overlay, then its public fallback definitions;
it composes the selected common profile and injects the result into the
provider session. Target-repository operational metadata cannot widen the
trusted catalog. Operational frontmatter in Junior and `agents-org` is active
only when its exact file bytes match the respective repository's default
branch. Dirty, untracked, and branch-only definitions are marked unpublished
and excluded from the trusted catalog until merged.
**Painful part:** Agent definitions for Example Org repos live in THOSE repos. Junior should not duplicate them. But junior needs its own agents for: (a) generic tasks not tied to a specific repo, (b) developing the bot itself, (c) fallback when target repo has no matching agent.
**"Finally" moment:** `!build` in a example-backend thread → loads example-backend's build.md agent. `!review` in a junior thread → loads junior's own review.md agent. No duplication. No drift.

## Full Vision

**Junior's own agents (`.claude/agents/` in this repo):**

| Agent | Purpose |
|---|---|
| `default.md` | The one Junior orchestrator. Handles broad Slack asks and owns support-channel bug runs. `lead.md`/`thinker.md` were folded into this file + `common/bug-pipeline.md` in the 3-way merge; `lead` is no longer used for new sessions. |
| `reproducer.md` | Two-phase Playwright walker — reproduces the bug, then validates the fix. |
| `review.md` | Code reviewer (6-pass methodology, inline GitHub comments). |
| `build.md` | Generic backend builder — also the durable-assignment worker the orchestrator hands fixes to. |
| `frontend.md` | Generic frontend builder — also the durable-assignment worker for UI fixes. |
| `architect.md` | System architect — specs, data models, state machines. |
| `pm.md` | Product manager — scoping, iterations, scope cuts. |
| `support/skills/<name>/SKILL.md` | Canonical shared playbooks. The agent `common:` profile reads these skills after any target-repo override; the org common overlay remains additive for private policy. This keeps one source for Claude, OpenCode, and Codex. |

**Private org overlay (`agents-org/`, mounted as a private submodule):**

Contains org-specific agents and common preamble files that don't belong in the public repo:
- `common/merge-workflow.md` — concrete token name, credentials path, exact merge invocation, multi-stage release flow.
- `common/runtime-environment.md` — concrete repo names, local dev URLs, production-like FQDN config, admin-credentials.yaml usage, impersonation flow.
- Any org-specific agents (e.g. internal task agents that name proprietary tooling).

**Loading priority for an agent `.md`:**
1. Target repo's `.claude/agents/<type>.md` (if `session.targetRepo` is set)
2. Org overlay's `<orgAgentsDir>/<type>.md`
3. Junior's `.claude/agents/<type>.md` (public fallback)
4. No agent (generic Claude with the common preamble alone)

**Loading order for common preamble:**
1. Per-file fallback tier — for each selected common profile name, the target repo's `.claude/agents/common/<name>.md` wins when present; otherwise Junior's public `.claude/agents/common/<name>.md` supplies that file.
2. Additive tier — org overlay's `<orgAgentsDir>/common/*.md` (always appended when overlay is configured).

### Trusted-definition publication gate

The trusted catalog is an authority boundary, not a prompt-discovery index.
For every definition with `operational.enabled: true`, Junior discovers the
repository's default remote ref (`origin/HEAD`, then `origin/main` or
`origin/master`; local `main`/`master` only when no remote ref exists) and
compares the on-disk file bytes with `git show
<default-ref>:<path>`. A mismatch, missing blob, unavailable ref, or non-Git
path is **unpublished**. The configured `.md` path must also be a tracked,
non-symlink regular file; resolving a link to another tracked payload never
publishes an authority-bearing definition. Unpublished definitions do not add capabilities,
permissions, mutation policy, aliases, variants, or handoff edges. If this
removes the required `default` orchestrator, startup fails closed.

`worktree-verify` is the one catalog-wide baseline capability added by the
trusted compiler to every published agent. It restores local inspection and
verification in a managed worktree without widening mutation policy, sandbox,
or human-gated operations.

This check is performed independently for the public Junior checkout and the
`agents-org` submodule checkout. Target-repository definitions remain
prompt-only and are never catalog sources.

**Per-agent context profile:**

Agents can opt out of preamble blocks via frontmatter dot-notation flags. Useful for lightweight task agents that don't need the full thread context.

```yaml
---
name: pr-summarize
description: One-sentence PR summary.
context.workspace: false
context.threadHistory: false
---
```

Flags: `identity`, `slack`, `workspace`, `threadHistory`, `agentState`. Missing or invalid values default to `true` (safe-but-heavy).

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
- Runtime-boundary evidence gate: major dependency, routing, packaging,
  build-config, publishing, and generated-artifact changes require an executed
  check or inspected artifact before approval. Durable review completion records
  one pinned `review` receipt and one `runtime-evidence` receipt; static/docs-only
  reviews must explicitly record `not-applicable:<reason>`. Private overrides
  retain the `pipeline-outcome` common contract and must settle the durable
  outcome after GitHub posting but before returning the Slack verdict.

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
