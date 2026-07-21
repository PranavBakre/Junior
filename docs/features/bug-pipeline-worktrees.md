# Bug-pipeline worktree isolation + shared dev-server queue

Status: **landed (Scopes 1, 2a, 2b)**. Step 4 (this doc sync) shipped 2026-04-30.

> **Current implementation note (2026-07-21):** Durable product and bug pipeline dispatch now owns worktree provisioning. Before an assignment starts, `SessionManager` resolves every durable `repoRef`, provisions one thread-scoped worktree per repo, persists the full path map, and chooses the process cwd from review/workstream affinity. Agents no longer depend on lead calling `register_worktree`. The trusted catalog permits repo-less planner/orchestrator work; repo-bound assignments fail closed until the run names a configured repo. The dev-server slot remains a sibling worktree at `<repo>.junior-worktrees/slack-dev-server`. Current source: [`src/worktree/pipeline-routing.ts`](../../src/worktree/pipeline-routing.ts), [`src/session/manager.ts`](../../src/session/manager.ts), [`src/lifecycle/dev-server.ts`](../../src/lifecycle/dev-server.ts), [`src/lifecycle/dev-server-queue.ts`](../../src/lifecycle/dev-server-queue.ts), and [`docs/code_index/pipeline-routing.md`](../code_index/pipeline-routing.md).

Implementation history:
- Scope-1 (PR #3, merged 2026-04-29): per-thread worktrees + `register_worktree` MCP tool. Code: `WorktreeManager.createWorktree(repo, threadId, baseRef?, branchOverride?)`, `ThreadSession.worktreePaths`, multi-repo `<workspace>` block in `buildWorkspaceBlock`.
- Scope-2a (PR #4, merged 2026-04-30): `DevServerManager` (`src/lifecycle/dev-server.ts`) — owns dev-server PID/branch tracking, idle TTL sweeper, shutdown teardown, startup orphan check. Independently fixed the leaked-`pnpm dev` bug.
- Scope-2b (PR #5, merged 2026-04-30): `DevServerQueue` (`src/lifecycle/dev-server-queue.ts`) — `proper-lockfile` per repo, `.lock.meta.json` (atomic write-tmp + rename) and append-only NDJSON `.queue` for waiter introspection, `onCompromised` handler wired to `stealStale` so stale-lock takeovers recover instead of crashing the bot. New `!devserver <branch> [repo]` / `!devserver status` / `!devserver kill <repo>` directives in `src/support/router.ts`.
- Pipeline-owned provisioning (PR #133, 2026-07-21): durable pipeline `repoRefs` are resolved and provisioned before assignment spawn. Multi-repo setup is coalesced per repo/thread; recovery continuations reuse the managed cwd; unknown refs and missing worktrees escalate durably instead of falling back to a developer checkout.

Captures the discussion in a Slack thread on 2026-04-29.

## Problem

For bug threads, junior's persistent agents (lead, thinker, reproducer) operate
directly on the bare target repos under `~/projects/<repo>/`. Specifically:

- `runtime-environment.md` and the agent prompts hardcode `~/projects/<repo>/` and tell agents to `cd` there for reading code, editing, `git checkout`, and `pnpm dev`.
- `WorktreeManager` exists and `runClaudeWithAgent` will create a per-thread worktree at `<repo>.junior-worktrees/slack-<threadId>` — but only when `session.targetRepo` is set, which never happens on the lead-driven bug pipeline.

Consequences:

- `thinker` writing the fix branch and `reproducer` phase-2 doing `git checkout <fix-branch>` both happen on the bare repo, on top of whatever branch the human developer has checked out. Active in-progress work gets clobbered.
- Concurrent bug threads on the same repo step on each other.

The complaint: junior must run inside worktrees for bug work. The pieces to build worktrees exist; the pipeline just doesn't use them.

## Why this is bigger than "just call createWorktree"

Three things tangle:

1. **One thread can need multiple repos.** `repo-routing.yaml` routes a bug to e.g. `{frontend: app-frontend, backend: app-backend}`. The session model has a single `worktreePath`. Need `worktreePaths: Record<repoName, path>` (or equivalent).
2. **Reproducer's dev servers run on fixed ports (3000, 8000) from the bare repo.** Phase-2 validation is "checkout fix branch, restart dev server, walk the same path." If the dev server runs from a worktree, two concurrent validations on the same repo collide on the port. If it runs from the bare repo, we're back to corrupting the dev's branch.
3. **Agent prompts hardcode the bare path.** Every reference to `~/projects/<repo>/` needs to become a per-thread worktree path injected via the existing workspace block.

## Proposal

### Scope-1 — per-thread worktrees for read/write

- Lead, on intake, reads `repo-routing.yaml` and creates one worktree per routed repo for this thread (`<repo>.junior-worktrees/slack-<threadId>`, branch `slack/<threadId>` off `defaultBase`).
- Session schema gains `worktreePaths: Record<repoName, path>` alongside the existing `worktreePath` (or replaces it).
- `runtime-environment.md` and agent prompts swap hardcoded `~/projects/<repo>/` references for the per-thread worktree paths, injected via the workspace block.
- `thinker` writes its fix branch in its repo's worktree. PR is opened from that branch.
- `reproducer` phase-1 reads code in the worktree (or bare — read-only is fine either way; consistency is easier).

This alone stops the cross-branch corruption from edits and `git checkout`.

### Scope-2 — shared dev-server slot with a queue (the dev-server problem)

The dev server can't trivially live in N concurrent worktrees on fixed ports. The cleanest answer is queueing rather than per-thread ports.

- Each repo gets a **dedicated dev-server worktree** at `<repo>.junior-worktrees/slack-dev-server`. Dev servers always run from there. The bare repo is never touched by junior.
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
- **Reuse across validations on the same branch.** When the queue lock is acquired by a thread whose fix branch matches the running dev server, no restart — just walk. (Cold-starting `pnpm dev` for app-frontend is ~30s, not free.)
- **Restart on branch change.** When the lock is acquired with a different branch than the running server, kill the running PID, `git checkout` the new branch in the dev-server worktree, spawn a fresh `pnpm dev`, wait for ready (curl the port until 200), then hand off.
- **Idle TTL.** No validations for N minutes → kill the dev server. Default ~30 min.
- **Junior shutdown.** Graceful shutdown kills all tracked dev-server PIDs. Same hook as the rest of the lifecycle teardown in `src/lifecycle/`.
- **Crash recovery.** On startup, scan the dev-server worktree paths for any orphan listener on the configured ports and kill it before junior tries to spawn its own. (Or: refuse to start if the port is held by something we didn't spawn — safer.)

This bumps the dev-server worktree from a passive checkout location to an actively managed slot: junior owns the spawn, the kill, and the readiness probe.

## Decisions

- **Session schema.** Extend, don't replace. Keep the existing `session.worktreePath` (single-repo flow for `!repo <name>` threads) and add `session.worktreePaths: Record<repoName, path>` for the bug pipeline. Bug threads populate the map; non-bug threads keep using the single field. Avoids regressing the existing flow.
- **Lock granularity.** One queue per repo. We have three repo queues: `app-frontend` (FE), `app-admin` (FE), `app-backend` (BE). A FE-only bug only contends with other FE-only bugs on the same FE repo; a full-stack bug acquires both its FE queue and `app-backend` independently. Mixed-repo bugs may deadlock if two threads acquire repos in opposite order — acquire in a fixed alphabetical order to avoid this.
- **Slot timeout.** 5–10 min hard timeout on the validation slot. Lock auto-releases and posts a Slack note (`reproducer phase-2 timed out on <repo> after Nm — slot released, dev server killed`). Reproducer's outcome falls back to `needs-human`.
- **Idle TTL.** 20 min of no validations → kill the dev server. Cold-start cost re-paid on the next validation but the host stays clean.
- **Human's bare-repo dev server.** If a port is held when junior tries to spawn from the dev-server worktree, do NOT kill the listener. Detect the conflict, post "can't validate `<repo>` right now — port `<n>` is held by something junior didn't spawn. Free the port and re-dispatch `!reproducer validate`." Reproducer outcome → `needs-human`.
- **Manual escape hatch.** Add `!devserver kill <repo>` (and `!devserver status` for symmetry). Useful when junior's tracking drifts from reality.

## Queue implementation — filesystem lock

**Decided: filesystem lock via `proper-lockfile` on `<repo>.junior-worktrees/slack-dev-server/.lock`.** Picked for durability under heavy usage and to leave the door open for multiple junior instances or long-lived background processes coordinating on the same host. In-process primitives (`async-mutex`, `p-queue`) were considered and rejected because they don't survive a junior restart mid-validation.

What this means concretely:

- Each repo's dev-server worktree has its own `.lock` file. `proper-lockfile.lock(<repo>.junior-worktrees/slack-dev-server, { stale: <slotTimeoutMs>, retries: { forever: true, minTimeout: 1000, maxTimeout: 5000 } })` is the acquire call.
- Acquire returns a `release` function. Reproducer phase-2 wraps the entire validation walk in `try { await acquire(); ... } finally { await release(); }`.
- `stale` config doubles as the slot timeout — if a holder crashes or hangs past the threshold, `proper-lockfile` lets the next acquirer steal the lock. We choose `stale = 10 min` (top of the 5–10 min slot-timeout range).
- The lock file co-locates with metadata: alongside `.lock` we write `.lock.meta.json` with `{ holderThreadId, holderPid, branch, acquiredAt }`. Future acquirers / `!devserver status` read it for human-friendly waiter context.
- Queue-depth introspection (the "you're 3rd in line" UX from the in-process options) is NOT given for free by `proper-lockfile`. We get it back by maintaining a sibling `.queue` file: each waiter appends `{ threadId, enqueuedAt }` on entry and removes itself on exit. Read this file to answer `!devserver status`.

Trap to watch:

- `proper-lockfile` polling defaults are conservative; under heavy contention with 5+ waiters we want the retry intervals tuned tighter than defaults so threads don't sit longer than the actual lock-holder's hold time.
- Stale-lock takeover is automatic but blunt — when `proper-lockfile` detects a stale lock, it just steals it. We need to ALSO kill any orphan `pnpm dev` PID we find listening on the port at takeover time, otherwise the new holder restarts a server while the old one is still bound.
- `proper-lockfile` writes the lockfile inside the directory you point at; the dev-server worktree's `.gitignore` must cover `.lock*` and `.queue*` so they don't show up as untracked.

## Implementation specifics

### Who creates worktrees, and how

**Historical Scope-1 design:** lead initiated worktree setup by calling the slack-bot MCP tool `register_worktree(repo, branch?)` after writing `state.json`. The tool:

1. Resolves the repo's `RepoConfig`. Errors if unknown.
2. If `repo.worktreeSetupCommand` is configured, runs the target-repo command as `<repo.path>/<command> <branch> --path <worktreePath> --base <baseRef>`. Otherwise runs `git fetch origin --prune` and `git worktree add <worktreePath> -b <branch> <baseRef>` directly.
3. Sets `worktreePath = <repo.path>.junior-worktrees/slack-<threadId>` and `branch = slack/<threadId>` (unless caller overrides).
4. Persists `session.worktreePaths[repo] = worktreePath` via `SessionManager.updateSession`.
5. Returns `{ path, branch }` to the caller.

**Current behavior:** pipeline dispatch does not rely on that prompt convention. `SessionManager` resolves the run's durable `repoRefs`, provisions every configured repo before spawn, and injects the resulting path map. `register_worktree` remains available for explicit/manual non-pipeline routing, but pipeline correctness no longer depends on an agent remembering to call it.

### Multi-repo workspace block format

`buildWorkspaceBlock` in `slack/thread-context.ts` currently emits one workspace. Extend it: when `session.worktreePaths` has entries, emit a block listing all of them. Format:

```
<workspace>
You have isolated git worktrees for this thread. ALWAYS use these paths
for reading code, editing files, and running git commands. NEVER touch
the bare repos under ~/projects/. NEVER run dev servers
yourself — post `!devserver <branch>` instead.

repo: app-frontend
  worktree: /Users/.../projects/app-frontend.junior-worktrees/slack-<tid>
  branch:   slack/<tid>
  base:     origin/main

repo: app-backend
  worktree: /Users/.../projects/app-backend.junior-worktrees/slack-<tid>
  branch:   slack/<tid>
  base:     origin/main
</workspace>
```

For non-bug threads (single `worktreePath`), keep the existing single-workspace format. The block is always injected on first turn; on resumed turns, only re-injected if paths changed (rare — usually only at intake).

### Agent prompt rewrite plan (lands WITH Scope-1, not after)

These prompt edits shipped with the original `register_worktree` tool. They remain useful workspace guidance, while pipeline-owned provisioning is now the enforcement boundary.

- **`runtime-environment.md`**: replace the "Repo locations" section. New text says: "Repo paths for THIS thread are listed in the `<workspace>` block at the top of your prompt. Use those — never `~/projects/<repo>/` directly. The bare repos are the human developer's working trees; touching them corrupts active branches." Also: "Don't run `pnpm dev` / `npm run dev` / any dev server yourself. Post `!devserver <branch> [repo]` in the thread; junior owns the dev-server slot. Wait for junior's ready message before walking."
- **`lead.md`** (historical): originally called `register_worktree` during intake. Current pipeline dispatch provisions from durable `repoRefs`; lead only needs to ensure those refs are correct.
- **`reproducer.md`**: replace "check out the fix branch in `~/projects/<repo>/`" with "post `!devserver <branch> <repo>` and wait for junior's `ready` reply. Walk against `localhost:<port>` as before."
- **`thinker.md`**: no path edits needed — it already follows whatever cwd it's spawned in (which will be the worktree once Scope-1 lands). Add one sentence: "the workspace block at the top of your prompt has the repo paths. Use them; don't cd elsewhere."

### `RepoConfig` schema additions

```ts
interface RepoConfig {
  name: string;
  path: string;
  defaultBase: string;
  // NEW:
  devCommand?: string;          // "pnpm dev" | "npm run dev" — junior runs this
  devPort?: number;             // 3000 | 3001 | 8000 — readiness probe target
  readyUrl?: string;            // "http://localhost:3000" — what junior curls
  worktreeSetupCommand?: string; // optional target-repo setup command; receives branch, --path, and --base
}
```

Repos that don't run dev servers (e.g. a docs-only repo) leave the dev fields unset; `!devserver` returns "no dev server configured for `<repo>`."

This kills the recurring pnpm-vs-npm class of mistake — agents never invoke either; junior reads the configured command.

### `!devserver` directive

Lives in `src/support/router.ts` next to the persistent-agent dispatch logic. Form: `!devserver <branch> [repo]` (repo optional — defaults to all repos in `session.worktreePaths`). Sub-commands: `!devserver status`, `!devserver kill <repo>`.

Flow on `!devserver <branch>`:

1. Junior posts a "queued" reaction immediately so the thread sees it was picked up.
2. For each target repo, async: acquire the per-repo `proper-lockfile` lock. While waiting, update `.queue` file with `{ threadId, enqueuedAt }`.
3. On lock acquired: read `.lock.meta.json` → if `currentBranch === <branch>`, skip restart (reuse the warm dev server). Otherwise: kill the tracked PID, `git fetch && git checkout <branch>` in the dev-server worktree, spawn `<devCommand>`, poll `<readyUrl>` until 200 (90s timeout). Update `.lock.meta.json`.
4. Post a Slack message: `dev-server for <repo> on <branch>: ready @ localhost:<port>` (or `failed: <reason>` / `port held by external listener — free it and retry`).
5. Hold the lock for the validation walk's `slotTimeoutMs` (default 10 min). On `release`: don't kill the dev server (the next caller may want it warm) — just release the lock and update `.lock.meta.json` to `{ holderThreadId: null, ... }`.

The reproducer's `!reproducer validate ...` is dispatched by lead AFTER junior posts `ready`. Lead reads junior's reply in its next turn and only then dispatches reproducer.

Humans posting `!devserver fix/foo app-frontend` from a thread (or even outside any bug pipeline) get the same flow. Useful for quick "is this branch broken?" checks.

### Lockfile bootstrap

The lockfile path is `<repo>.junior-worktrees/slack-dev-server/.lock`. The dev-server worktree must exist before the lock can be acquired. Junior on boot:

1. For each `RepoConfig` with a `devCommand`, ensure `<repo>.junior-worktrees/slack-dev-server/` exists as a worktree on `defaultBase`. Create it if missing using the same logic as `register_worktree` (with branch `dev-server-slot/<repo>` to avoid clashing with thread worktrees).
2. Scan `<repo>.junior-worktrees/slack-dev-server/.lock.meta.json`. If it claims a holder PID that doesn't exist anymore, treat as orphan — clear the lock and the queue file.
3. Scan the configured `devPort`. If a listener exists and isn't us (PID mismatch with `.lock.meta.json`), refuse to spawn until the human frees it. Log it loudly.

This is the entirety of `lifecycle/dev-server.ts`'s startup path; the rest is event-driven from `!devserver` directives.

### Cleanup integration

Extend `lifecycle/cleanup.ts`:

- For each stale session, walk `session.worktreePaths` (in addition to the old single `worktreePath`). For each `(repo, path)`, run `worktreeManager.isWorktreeDirty(path)` — if clean, `removeWorktree(repo, threadId)`; if dirty, log a warning and skip.
- The dev-server worktree (`<repo>.junior-worktrees/slack-dev-server/`) is NEVER cleaned up by stale-session sweeps. It's a permanent fixture, owned by junior, lifecycled by `lifecycle/dev-server.ts`.

### Test plan

- **Unit**:
  - `worktreeManager.createWorktree` / `removeWorktree` already covered. Add coverage for the `worktreeSetupCommand` branch — mock `Bun.spawn` and assert args.
  - `register_worktree` MCP handler — mocks the worktree manager + session store, asserts `session.worktreePaths` is updated and the right path is returned.
  - `buildWorkspaceBlock` with `worktreePaths` populated — assert the multi-repo format renders correctly.
  - `!devserver` directive parser — `!devserver <branch>`, `!devserver <branch> <repo>`, `!devserver status`, `!devserver kill <repo>` all parse correctly.
  - Lifecycle: stub `proper-lockfile`, assert acquire / release / stale-takeover behavior.
- **Integration (real-git, real-fs)**:
  - End-to-end: spin up `register_worktree` against a tmpdir-cloned repo, verify the worktree exists, branch is correct, `worktreePaths` is persisted.
  - `!devserver` end-to-end: stub the dev command with a script that listens on a port; assert the lockfile + ready-probe + restart-on-branch-change paths.
- **Manual (smoke)**:
  - File a real bug in #bugs-backlog. Confirm worktrees get created, agents reference them in their tool calls (grep their stream output for the worktree path), `!devserver` ready message appears, reproducer phase-2 walks against the warm server.

## What's not in scope here

- Replacing `repo-routing.yaml` with anything else.
- Changing how `thinker` opens PRs.
- Multi-repo dev-server orchestration beyond the FE+BE pair.
- Auto-cleanup of the per-thread worktrees on bug-thread completion. Today `cleanupStaleSessions` deletes stale session rows only; worktree deletion must be a separate dirty-checked operation.

## Build order

Each step lands as one commit (or one PR) with prompt updates and code changes co-located so agents don't fall out of sync with the runtime.

1. **Scope-1 — per-thread worktrees + prompt rewrite (one commit).**
   - Session schema: add `session.worktreePaths: Record<repoName, path>`. Migration: existing sessions default to `{}`; old `worktreePath` field stays for the `!repo` flow.
   - `RepoConfig`: add `worktreeSetupCommand?` (dev-server fields land in step 2).
   - `WorktreeManager.createWorktree`: respect `worktreeSetupCommand` if set.
   - New MCP tool `register_worktree(repo, branch?)` in `src/mcp/slack-server.ts`. Persists to `session.worktreePaths`.
   - `buildWorkspaceBlock`: render the multi-repo format when `worktreePaths` is non-empty.
   - Agent prompt updates: `runtime-environment.md`, `lead.md`, `reproducer.md`, `thinker.md` per the rewrite plan above.
   - Tests: unit for the MCP handler + workspace block; integration for end-to-end worktree creation.
2. **Scope-2a — dev-server lifecycle (one commit).**
   - `RepoConfig`: add `devCommand`, `devPort`, `readyUrl`.
   - New module `src/lifecycle/dev-server.ts` — tracks PID + branch per repo, spawn/kill/ready-probe, idle TTL, shutdown teardown.
   - Bootstrap on junior boot: ensure `<repo>.junior-worktrees/slack-dev-server/` exists; orphan-PID check; external-listener check.
   - Tests: unit with mocked `Bun.spawn` for spawn/kill/probe paths.
3. **Scope-2b — `!devserver` directive + lockfile queue (one commit).**
   - Add `proper-lockfile` dep.
   - Lockfile + `.lock.meta.json` + `.queue` files at `<repo>.junior-worktrees/slack-dev-server/`.
   - `!devserver <branch> [repo]`, `!devserver status`, `!devserver kill <repo>` directives in `src/support/router.ts`.
   - Reproducer + lead prompt updates: reproducer waits for `!devserver` ready; lead orchestrates the dispatch sequence.
   - Tests: directive parser unit; lockfile integration with a stubbed dev command.
4. **Doc sync (one commit).**
   - Update `docs/features/worktree-manager.md`, `docs/features/process-lifecycle.md`, `docs/features/persistent-agents.md` to point at this design as the current model.
