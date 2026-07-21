# Code Index: Pipeline Worktree Routing

Resolves durable pipeline repository references and chooses the Junior-managed worktree used as an assignment's process cwd. The session manager provisions every resolved repo before spawning a pipeline worker; this module contains the deterministic, side-effect-free routing rules.

## Code Index

### src/worktree

| Symbol | File | Purpose |
|---|---|---|
| `resolvePipelineRepos(repos, repoRefs)` | `pipeline-routing.ts` | Resolves configured repositories in durable run order, dedupes resolved and unresolved refs, and returns unknown or ambiguous refs explicitly so dispatch can fail closed. |
| `inferPipelinePrimaryRepo(input)` | `pipeline-routing.ts` | Chooses the initial cwd from review PR affinity, durable assignment workstream/agent affinity, then durable repo order. Emits diagnostics before any ambiguous fallback. |
| `repoMatchesRef(repoName, ref)` | `review-routing.ts` | Matches configured names against short and owner-qualified repository refs. Shared by review and pipeline routing. |

### src/session

| Symbol | File | Purpose |
|---|---|---|
| `SessionManager.runRunnerWithAgent(...)` | `manager.ts` | Reads the active assignment/run, resolves every durable repo ref, provisions all per-thread worktrees, persists `worktreePaths`, clears stale utility cwd, and spawns from the selected managed path. |
| `SessionManager.ensurePipelineWorktree(...)` | `manager.ts` | Reuses an existing deterministic worktree or single-flights concurrent creation for the same repo/thread. Rejects a setup result whose path differs from the manager-owned path. |

## Routing Order

1. Resolve every durable `repoRef`. Any unknown or ambiguous ref fails the assignment with an actionable setup error; Junior never falls back to a developer checkout.
2. For `review`, an explicit PR URL may select one of the already-resolved repos.
3. For other agents, a single `workstream:` assignment context ref wins; otherwise `frontend` and `build` use their catalog affinity.
4. If affinity is absent or ambiguous, emit a diagnostic and use durable repo order.

Repo-less trusted planner and orchestrator roles may operate in Junior's shared workspace because they have no target repository. Builder, reviewer, reproducer, and unknown roles require a configured repo and managed worktree; the decision comes from the trusted agent catalog rather than a role-name allowlist. A failed assignment can move the run to `needs-human`, but plain human/orchestrator turns do not inherit that assignment's setup gate, so the thread remains usable for diagnosis and `!reset`.

## Failure and Recovery

- Worktree setup failures are converted into the active assignment's durable pipeline settlement before the runner starts.
- If settlement itself fails, the session still leaves `busy`, records the combined setup/settlement error, and invokes the normal error callback.
- Provider cold starts and bounded pipeline continuations reuse the persisted managed cwd and injected multi-repo path map.

## Dependencies

- **Uses:** `config.RepoConfig`, `worktree/review-routing`, `WorktreeManager`, pipeline run/assignment state.
- **Used by:** `SessionManager` pipeline dispatch and recovery.
