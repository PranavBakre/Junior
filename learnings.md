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

## Known Gaps

- No source code yet — CLAUDE.md is written against the design doc, not working code. Rules and structure sections need updating as implementation begins.
- Open questions from the feature doc (stream-json schema, `--resume` + `--worktree` interaction, session locking) are unresolved and will affect implementation choices.
