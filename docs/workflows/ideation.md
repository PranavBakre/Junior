# Ideation Workflow

How to scope and plan a feature before writing any code. Every feature must go through this before building begins.

This workflow is **repository-neutral**. Discover stack conventions, directory layout, and verification commands from the **target repository** — its `CLAUDE.md` / `AGENTS.md`, package scripts, feature docs, and any structured repository profile — not from this file.

## Step 1: Define the Problem

Answer these before anything else:

| Question | Why it matters |
|---|---|
| Who specifically has this problem? | Prevents building for nobody |
| What do they do today without this? | Reveals the real pain point |
| What's the painful part? | Focuses the solution |
| What would make them say "finally"? | Defines the magic moment |

Do not proceed until you have clear, specific answers — not vague ones.

## Step 2: Map the Full Feature

Before cutting anything, write out what the complete, ideal version looks like. What does this feature do when it's fully done?

List every capability, screen, integration, and edge case you can think of. Don't filter yet — this is the ceiling, not the plan.

```
FEATURE: [Name]
PROBLEM: [Who has what pain]

FULL VISION:
- [Capability 1]
- [Capability 2]
- [Capability 3]
- ...

USER FLOW (end state):
  [Step 1] → [Step 2] → [Step 3] → ... → [Outcome]

DEPENDENCIES:
- [What this feature needs from other features or external services]
- [Data it consumes or produces]
```

## Step 3: Check Existing Patterns

Before designing the implementation, check what's already built in the **target repository**. Most new features should follow established conventions there.

| Question | Where to look (discover in target repo) |
|---|---|
| Does a similar domain / module already exist? | Target `CLAUDE.md`, package layout, feature docs, code indexes |
| Are there shared types / schemas / contracts to extend? | Shared packages, API contracts, OpenAPI/schema dirs named by the repo |
| Does this need a state machine or workflow? | Existing state/transition patterns already in the codebase |
| Does this touch existing storage? | Schema/migration directories and data-access layers the repo already uses |
| Does this need new shared infrastructure? | Shared libs, plugins, or platform modules documented in the repo |

New features should reuse existing patterns. Only introduce new patterns if existing ones don't fit — and document why in the feature plan.

## Step 4: Break Into Iterations

Decompose the full vision into a sequence of iterations. Each iteration should:
- Deliver a **working, testable increment**
- **Build on the previous** — iteration N assumes iteration N-1 works
- Be **scoped to ~1-2 hours** of focused work

### Iteration 0: Core Proof (~20 min)

The smallest unit that proves the idea works. Prefer logic without UI when possible.

- One sentence to describe
- Proves the core logic — not plumbing, not auth, not UI
- If you can't describe it in one sentence, scope is too big

**When to skip iteration 0:** If the feature is a standard CRUD / config surface that already follows existing patterns in the target repo, iteration 0 may not add value. Skip it when the novel part is integration, not logic. Keep it when there's genuinely new logic to prove (pipeline, complex algorithm, external API integration).

### Iterations 1-N: Progressive Build

Each iteration adds one slice of the full vision:

```
ITERATION 0: [Core proof — what it proves]
ITERATION 1: [First usable slice — what the user can do after this]
ITERATION 2: [Next slice — what new capability this adds]
...
ITERATION N: [Final slice — feature matches the full vision]
```

For each iteration, note:
- **What it adds** (one sentence)
- **What the user can do after** (the test — how do you know it works?)
- **What it defers** (what's explicitly NOT in this iteration)

### How to sequence iterations

| Principle | Example |
|---|---|
| Core logic first, UI second | Scoring algorithm before the scoring dashboard |
| Happy path first, edge cases later | "Submit form" before "payload too large" handling |
| Read before write | Display records before allowing edits |
| Manual triggers first, automation later | Click "run" before auto-run on event |
| Follow established patterns | New module mirrors an existing one in the same repo |

Sequence layers in the order the **target repository** already uses (for example: model → service → API → UI, or package → app → integration). Do not invent a foreign stack order.

## Step 5: Identify Cuts and Shortcuts

For each iteration, note what shortcuts are acceptable **for this product**. Examples (adapt or ignore based on the target repo):

| Instead of... | Shortcut for early iterations |
|---|---|
| Full RBAC / fine-grained auth | Coarse tenancy or single-role access first |
| Real-time updates | Manual refresh / reload |
| Full error handling | Basic error surfaces + logs |
| Pagination | Bounded result sets |
| Background processing | Synchronous path for the first slice |

As iterations progress, shortcuts get replaced with real implementations. Note which iteration replaces each shortcut.

## Step 6: Write the Plan

```
FEATURE: [Name]
PROBLEM: [One sentence — who has what pain]

FULL VISION:
  [Complete description of the finished feature]

ITERATIONS:
  0. [Core proof] → Test: [how to verify]
  1. [First slice] → Test: [how to verify] → Defers: [what's not included]
  2. [Second slice] → Test: [how to verify] → Defers: [what's not included]
  ...
  N. [Final slice — matches full vision] → Test: [how to verify]

SHORTCUTS (and when they get replaced):
  - [Shortcut] → replaced in iteration [N]

DEPENDENCIES:
  - [What this feature needs from other features]

CUT LIST (not in any iteration — true v2):
  - [Things explicitly out of scope for the entire plan]
```

Save this under the target repository's feature-doc convention (often `docs/features/<feature-name>.md`) and get alignment before writing code.

## What NOT To Do During Ideation

- Don't write code — not even "just a quick prototype"
- Don't handwave complexity — if it sounds hard, it is hard
- Don't skip straight to UI wireframes — nail the core logic first
- Don't leave iterations vague — "add polish" is not an iteration, specify what polish
- Don't plan iterations that can't be tested independently
- Don't speculatively add iterations beyond what you'll build — if it's not planned for the current scope, put it in the cut list
- Don't hardcode another product's framework, directory layout, or package-manager commands into the plan
