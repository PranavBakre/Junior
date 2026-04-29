# Bug-pipeline worktree isolation + shared dev-server queue

Status: design / not yet built. Captures the discussion in a Slack thread on 2026-04-29.

## Problem

For bug threads, junior's persistent agents (lead, thinker, reproducer) operate
directly on the bare target repos under `~/openclaw-projects/<repo>/`. Specifically:

- `runtime-environment.md` and the agent prompts hardcode `~/openclaw-projects/<repo>/` and tell agents to `cd` there for reading code, editing, `git checkout`, and `pnpm dev`.
- `WorktreeManager` exists and `runClaudeWithAgent` will create a per-thread worktree at `<repo>/.claude/worktrees/slack-<threadId>` — but only when `session.targetRepo` is set, which never happens on the lead-driven bug pipeline.

Consequences:

- `thinker` writing the fix branch and `reproducer` phase-2 doing `git checkout <fix-branch>` both happen on the bare repo, on top of whatever branch the human developer has checked out. Active in-progress work gets clobbered.
- Concurrent bug threads on the same repo step on each other.

The complaint: junior must run inside worktrees for bug work. The pieces to build worktrees exist; the pipeline just doesn't use them.

## Why this is bigger than "just call createWorktree"

Three things tangle:

1. **One thread can need multiple repos.** `repo-routing.yaml` routes a bug to e.g. `{frontend: gx-client-next, backend: gx-backend}`. The session model has a single `worktreePath`. Need `worktreePaths: Record<repoName, path>` (or equivalent).
2. **Reproducer's dev servers run on fixed ports (3000, 8000) from the bare repo.** Phase-2 validation is "checkout fix branch, restart dev server, walk the same path." If the dev server runs from a worktree, two concurrent validations on the same repo collide on the port. If it runs from the bare repo, we're back to corrupting the dev's branch.
3. **Agent prompts hardcode the bare path.** Every reference to `~/openclaw-projects/<repo>/` needs to become a per-thread worktree path injected via the existing workspace block.

## Proposal

### Scope-1 — per-thread worktrees for read/write

- Lead, on intake, reads `repo-routing.yaml` and creates one worktree per routed repo for this thread (`<repo>/.claude/worktrees/slack-<threadId>`, branch `slack/<threadId>` off `defaultBase`).
- Session schema gains `worktreePaths: Record<repoName, path>` alongside the existing `worktreePath` (or replaces it).
- `runtime-environment.md` and agent prompts swap hardcoded `~/openclaw-projects/<repo>/` references for the per-thread worktree paths, injected via the workspace block.
- `thinker` writes its fix branch in its repo's worktree. PR is opened from that branch.
- `reproducer` phase-1 reads code in the worktree (or bare — read-only is fine either way; consistency is easier).

This alone stops the cross-branch corruption from edits and `git checkout`.

### Scope-2 — shared dev-server slot with a queue (the dev-server problem)

The dev server can't trivially live in N concurrent worktrees on fixed ports. The cleanest answer is queueing rather than per-thread ports.

- Each repo gets a **dedicated dev-server worktree** at a fixed path (e.g. `<repo>/.claude/dev-server`). Dev servers always run from there. The bare repo is never touched by junior.
- Junior holds an in-process **per-repo mutex** (or `p-queue` with concurrency=1). `reproducer` phase-2 acquires the lock for each repo it needs → `git fetch && git checkout <fix-branch>` in the dev-server worktree → restart dev server → walk → release. Other threads wait.
- `thinker` keeps writing in its own per-thread worktree (so concurrent thinking is fine); only the validation slot is serialised.

Tradeoffs accepted:

- Phase-2 validations queue rather than run in parallel. Acceptable in practice — humans already validate serially on one box.
- Per-thread ports avoided entirely. No `.env` rewrites, no port allocation logic, no telling agents "your port is 3047."

The one trap: a stuck or timed-out validation holding the lock wedges the queue. Need a hard timeout on the slot that releases it, kills the dev server cleanly, and posts a Slack note so the next caller doesn't block forever.

## Dev-server process lifecycle (separate but related)

Even before queueing, today's reproducer has no kill path: when phase-2 spawns `pnpm dev` and the agent's turn exits, the child processes keep running. After a few bugs, there are stale dev servers holding the ports, the validation walks pass against the wrong branch, and the host accumulates Node processes. Resolving this is a hard prerequisite for the queue idea — the queue assumes junior owns the dev-server lifecycle.

Lifecycle policy proposed:

- Junior tracks the dev server it spawns (PID + repo + current branch) per dev-server worktree.
- **Reuse across validations on the same branch.** When the queue lock is acquired by a thread whose fix branch matches the running dev server, no restart — just walk. (Cold-starting `pnpm dev` for gx-client-next is ~30s, not free.)
- **Restart on branch change.** When the lock is acquired with a different branch than the running server, kill the running PID, `git checkout` the new branch in the dev-server worktree, spawn a fresh `pnpm dev`, wait for ready (curl the port until 200), then hand off.
- **Idle TTL.** No validations for N minutes → kill the dev server. Default ~30 min.
- **Junior shutdown.** Graceful shutdown kills all tracked dev-server PIDs. Same hook as the rest of the lifecycle teardown in `src/lifecycle/`.
- **Crash recovery.** On startup, scan the dev-server worktree paths for any orphan listener on the configured ports and kill it before junior tries to spawn its own. (Or: refuse to start if the port is held by something we didn't spawn — safer.)

This bumps the dev-server worktree from a passive checkout location to an actively managed slot: junior owns the spawn, the kill, and the readiness probe.

## Decisions

- **Session schema.** Extend, don't replace. Keep the existing `session.worktreePath` (single-repo flow for `!repo <name>` threads) and add `session.worktreePaths: Record<repoName, path>` for the bug pipeline. Bug threads populate the map; non-bug threads keep using the single field. Avoids regressing the existing flow.
- **Lock granularity.** One queue per repo. We have three repo queues: `gx-client-next` (FE), `gx-admin-client` (FE), `gx-backend` (BE). A FE-only bug only contends with other FE-only bugs on the same FE repo; a full-stack bug acquires both its FE queue and `gx-backend` independently. Mixed-repo bugs may deadlock if two threads acquire repos in opposite order — acquire in a fixed alphabetical order to avoid this.
- **Slot timeout.** 5–10 min hard timeout on the validation slot. Lock auto-releases and posts a Slack note (`reproducer phase-2 timed out on <repo> after Nm — slot released, dev server killed`). Reproducer's outcome falls back to `needs-human`.
- **Idle TTL.** 20 min of no validations → kill the dev server. Cold-start cost re-paid on the next validation but the host stays clean.
- **Human's bare-repo dev server.** If a port is held when junior tries to spawn from the dev-server worktree, do NOT kill the listener. Detect the conflict, post "can't validate `<repo>` right now — port `<n>` is held by something junior didn't spawn. Free the port and re-dispatch `!reproducer validate`." Reproducer outcome → `needs-human`.
- **Manual escape hatch.** Add `!devserver kill <repo>` (and `!devserver status` for symmetry). Useful when junior's tracking drifts from reality.

## Queue implementation — filesystem lock

**Decided: filesystem lock via `proper-lockfile` on `<repo>/.claude/dev-server/.lock`.** Picked for durability under heavy usage and to leave the door open for multiple junior instances or long-lived background processes coordinating on the same host. In-process primitives (`async-mutex`, `p-queue`) were considered and rejected because they don't survive a junior restart mid-validation — a crash with the lock held leaves no on-disk record, and the next junior boot has no way to know whether the dev server it spawns is fighting another instance.

What this means concretely:

- Each repo's dev-server worktree has its own `.lock` file. `proper-lockfile.lock(<repo>/.claude/dev-server, { stale: <slotTimeoutMs>, retries: { forever: true, minTimeout: 1000, maxTimeout: 5000 } })` is the acquire call.
- Acquire returns a `release` function. Reproducer phase-2 wraps the entire validation walk in `try { await acquire(); ... } finally { await release(); }`.
- `stale` config doubles as the slot timeout — if a holder crashes or hangs past the threshold, `proper-lockfile` lets the next acquirer steal the lock. We choose `stale = 10 min` (top of the 5–10 min slot-timeout range).
- The lock file co-locates with metadata: alongside `.lock` we write `.lock.meta.json` with `{ holderThreadId, holderPid, branch, acquiredAt }`. Future acquirers / `!devserver status` read it for human-friendly waiter context.
- Queue-depth introspection (the "you're 3rd in line" UX from the in-process options) is NOT given for free by `proper-lockfile`. We get it back by maintaining a sibling `.queue` file: each waiter appends `{ threadId, enqueuedAt }` on entry and removes itself on exit. Read this file to answer `!devserver status`.

Trap to watch:

- `proper-lockfile` polling defaults are conservative; under heavy contention with 5+ waiters we want the retry intervals tuned tighter than defaults so threads don't sit longer than the actual lock-holder's hold time.
- Stale-lock takeover is automatic but blunt — when `proper-lockfile` detects a stale lock, it just steals it. We need to ALSO kill any orphan `pnpm dev` PID we find listening on the port at takeover time, otherwise the new holder restarts a server while the old one is still bound.
- `proper-lockfile` writes the lockfile inside the directory you point at; the dev-server worktree's `.gitignore` must cover `.lock*` and `.queue*` so they don't show up as untracked.

## What's not in scope here

- Replacing `repo-routing.yaml` with anything else.
- Changing how `thinker` opens PRs.
- Multi-repo dev-server orchestration beyond the FE+BE pair.
- Auto-cleanup of the per-thread worktrees on bug-thread completion (already covered by the existing worktree cleanup feature).

## Build order (rough)

1. Scope-1: session schema (`worktreePaths`), lead-on-intake worktree creation per routed repo, prompt/runtime-doc updates, verify thinker writes in worktree.
2. Scope-2a — dev-server lifecycle: junior tracks spawned dev-server PIDs per repo, owns spawn/kill/readiness, idle TTL, shutdown teardown, startup orphan check. This is a prerequisite for the queue and also independently fixes today's leaked-process bug.
3. Scope-2b — queue: dedicated dev-server worktree per repo, repo-level mutex in junior, reproducer phase-2 acquires/releases, branch-change triggers restart, slot timeout + Slack note.
4. Update `worktree-manager.md`, `process-lifecycle.md`, and `persistent-agents.md` to reflect the new model. Add a runtime-environment.md note that all repo paths in agent prompts are dynamic per thread, and that reproducer must NEVER spawn its own `pnpm dev` — it requests a slot from junior.
