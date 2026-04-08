# Building Workflow

How to build a feature iteration. Follows conventions from [development-phases.md](../development-phases.md#conventions).

## Pre-Check

Before writing any code, verify:

1. Is there a feature plan in `docs/features/<name>.md`?
2. Which iteration are we on?
3. What's the scope for this iteration?
4. Do the conventions in [development-phases.md](../development-phases.md#conventions) apply?

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
```

Get confirmation before proceeding.

### 2. Follow Conventions

New code follows the patterns established across 7+ domains. See [development-phases.md](../development-phases.md#conventions) for the full list.

**Backend checklist:**
- [ ] Fastify plugin in `domains/<name>/plugin.ts`
- [ ] Service class in `domains/<name>/service.ts`
- [ ] Drizzle schema in `db/schema/<name>.ts` (if new tables)
- [ ] Zod schemas in `packages/shared/src/schemas/<name>.ts`
- [ ] Route validation via `@fastify/type-provider-zod`
- [ ] Company scoping on authenticated routes
- [ ] Proper HTTP status codes

**Frontend checklist:**
- [ ] Module in `modules/<name>/`
- [ ] React Query hooks in `hooks/`
- [ ] Pages in `pages/`
- [ ] Loading skeletons, error states, empty states
- [ ] Forms with React Hook Form + Zod resolver

### 3. Small Testable Chunks

Write code in pieces that can be tested immediately. After each piece:

- **Works?** → Commit and continue
- **Broken?** → Debug now, don't accumulate broken code

Never write more than ~50 lines without testing. The goal is always-working code with incremental additions.

### 4. Checkpoint = Commit

When a chunk works, commit immediately:

```bash
git add <specific-files>
git commit -m "feat(<domain>): [short description]

- What: [what was built]
- Status: [working/partial]"
```

Prefixes:
- `feat(<domain>):` — new feature or iteration complete
- `fix(<domain>):` — bug fix
- `refactor(<domain>):` — restructure without behavior change
- `chore:` — tooling, config, dependencies

### 5. Scope Discipline

When tempted to add something not in the current iteration:

> Note it in the feature doc under "CUT LIST" or as a future iteration. Finish the current iteration first.

### 6. Post-Iteration

After completing an iteration:

- [ ] Typecheck passes (`pnpm -r typecheck`)
- [ ] Feature works end-to-end (manual test)
- [ ] Feature doc updated with actual state
- [ ] Commit with descriptive message
- [ ] Any discoveries recorded in [learnings.md](../../learnings.md)

## Forbidden

- Rewriting entire files — make targeted edits
- Adding features not in the iteration scope
- Installing dependencies without explaining why
- Optimizing before it works
- Skipping the logic layer to jump to UI
- Deviating from conventions without documenting why
- Speculatively building for future iterations

## Allowed Shortcuts

Use these to maintain velocity in early iterations:

| Shortcut | When to resolve |
|---|---|
| `console.log` for errors | When adding proper error handling iteration |
| No pagination | When list exceeds ~50 items |
| Page refresh instead of optimistic updates | Polish iteration |
| Minimal styling | Polish iteration |
| No RBAC (company scoping only) | Auth iteration |

Shortcuts are tracked in the feature doc. Every shortcut must have a "replaced in iteration N" note.
