# Building Workflow

How to build a feature iteration. Process is repository-neutral; **conventions come from the target repository**.

## Pre-Check

Before writing any code, verify:

1. Is there a feature plan (often `docs/features/<name>.md` in the target repo)?
2. Which iteration are we on?
3. What's the scope for this iteration?
4. What does the target repo's guidance (`CLAUDE.md` / `AGENTS.md`, feature docs, package scripts) require?

If the answer to #1-3 is unclear — go back to [ideation](ideation.md).

## Building an Iteration

### 1. Plan Before Code

Before writing code for any iteration, output a plan:

```
ITERATION [N]: [Feature Name]

WHAT IT DOES:     [One sentence]
FILES TO CHANGE:  [List of files and what changes in each]
CONVENTION CHECK: [Which existing patterns this follows, any deviations and why]
RISKS:            [What might go wrong]
VERIFY WITH:      [Target-repo typecheck/test/lint scripts you will run]
```

A direct, well-scoped `build` / `fix` / `implement` assignment authorizes ordinary workspace work — do not invent a second go-word gate. Re-confirm only for mock/design ≠ build, scope expansion, ambiguous product intent, or high-risk/destructive/external actions.

### 2. Follow Target-Repo Conventions

Discover and follow patterns already established in the target repository. Do **not** assume a particular web framework, ORM, schema library, state library, or monorepo command.

**Discover, then execute:**

- [ ] Read target `CLAUDE.md` / `AGENTS.md` and the feature doc
- [ ] Match existing module / package / layering layout
- [ ] Reuse shared types, validators, and UI primitives already in the repo
- [ ] Use the repo's auth, tenancy, and error patterns when touching those surfaces
- [ ] Prefer the repo's design tokens / component library over ad-hoc styling
- [ ] Run verification via the repo's package scripts (typecheck, test, lint) as named in `package.json` / docs — never a hardcoded foreign command

### 3. Small Testable Chunks

Write code in pieces that can be tested immediately. After each piece:

- **Works?** → Checkpoint commit and continue
- **Broken?** → Debug now, don't accumulate broken code

Never write more than ~50 lines without testing. The goal is always-working code with incremental additions.

### 4. Checkpoint = Commit

When a chunk works, commit immediately with **explicit paths only** (`git add <files>` — never `git add -A` / `.`). Untracked local files are not yours to sweep in.

```bash
git add <specific-files>
git commit -m "feat(<area>): [short description]

- What: [what was built]
- Status: [working/partial]"
```

Prefixes (adapt to the target repo's commit style if it differs):
- `feat(<area>):` — new feature or iteration complete
- `fix(<area>):` — bug fix
- `refactor(<area>):` — restructure without behavior change
- `chore:` — tooling, config, dependencies

**Ownership:** builders create checkpoint commits when authorized. The orchestrator owns aggregate verification, push/PR create-or-update, and human gates unless the assignment explicitly asks the builder to open a PR.

### 5. Scope Discipline

When tempted to add something not in the current iteration:

> Note it in the feature doc under "CUT LIST" or as a future iteration. Finish the current iteration first.

### 6. Post-Iteration

After completing an iteration:

- [ ] Target-repo typecheck/lint/tests run; error counts compared to `main` baseline (state the delta)
- [ ] Feature works end-to-end for the iteration's test criteria
- [ ] Feature doc updated with actual state
- [ ] Checkpoint commit with descriptive message
- [ ] Durable lessons recorded via the memory tools / project learnings convention when appropriate
- [ ] Two consecutive clean verification passes (building-philosophy rule)

## Forbidden

- Rewriting entire files — make targeted edits
- Adding features not in the iteration scope
- Installing dependencies without explaining why
- Optimizing before it works
- Skipping the logic layer to jump to UI when the plan says otherwise
- Deviating from target-repo conventions without documenting why
- Speculatively building for future iterations
- Hardcoding another product's stack or monorepo commands as if they were universal

## Allowed Shortcuts

Use these to maintain velocity in early iterations — only when the feature plan names them:

| Shortcut | When to resolve |
|---|---|
| Verbose logging for errors | When adding proper error handling iteration |
| No pagination | When list size becomes a real problem |
| Full page refresh instead of optimistic updates | Polish iteration |
| Minimal styling | Polish iteration |
| Coarse auth before fine-grained RBAC | Auth iteration |

Shortcuts are tracked in the feature doc. Every shortcut must have a "replaced in iteration N" note.
