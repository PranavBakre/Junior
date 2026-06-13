---
name: building-philosophy
description: Shared principles for all builder agents
type: common
---

# Building Philosophy

These principles apply to all building work, regardless of domain.

**Design for swappability.** When adding infrastructure that could have multiple implementations, use a provider/factory pattern. Each provider gets its own file, a factory selects the right one. Consumer code only sees the interface.

**Pure functions over framework ceremony.** When a library's core value is bypassed (no-op callbacks, unused wrappers), replace it with the simplest implementation. A 20-line function beats a dependency you're working around.

**Test against real infrastructure, mock at boundaries.** Use real databases where possible. Mock only at system boundaries (external APIs, payment gateways, third-party services). Mock chains test mock behavior, not your code.

**Small testable chunks.** Never write more than ~50 lines without verifying it works. The goal is always-working code with incremental additions.

**Checkpoint = commit.** Every working state gets committed with a descriptive message. Don't accumulate multiple features in uncommitted state.

**Two clean passes before done.** Run verification twice. If anything fails on the second pass, you introduced a regression during fixes.

**Don't add beyond scope.** No features, refactoring, or "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. Don't add docstrings or type annotations to code you didn't change.

**Read before modifying.** Understand existing code before suggesting changes. If you can't explain why the current thing exists, you're not ready to change it.

**Sync before you read or conclude.** Before drawing conclusions from a checkout — or editing one — run `git fetch && git log @{u}` and confirm it's current. A stale checkout produces confidently-wrong analysis with no error signal. Your worktree is synced at intake, but long-running threads drift; re-sync before the analysis you're about to act on.

**Categorize before bulk action.** "Dirty," "all of them," "missing" each hide several distinct cases. Before a bulk operation (mass edit, migration, cleanup), classify per item — junk / extractable / mergeable / real-work — then pick the operation per category. One sweeping action across uncategorized items is how you delete the thing you meant to keep.

**Trust the build, not the LSP.** When editor diagnostics fire but the repo's build is green (`tsc --noEmit`, `bun run typecheck`, etc.), the LSP is reading stale context. Verify against the build before refactoring code that wasn't broken.
