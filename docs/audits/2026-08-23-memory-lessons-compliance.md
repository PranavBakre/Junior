# Memory-lessons compliance audit — 2026-08-23

## Scope and method

This audit compared Junior's shipped feature surface with the live v3 memory
store (`data/memory.db`, 2,630 active lesson claims at audit time). Three
read-only Luna/Terra agents reviewed independent feature families in parallel:

1. runner providers, sessions, Slack ingress, lifecycle, and worktrees;
2. memory, routes, agents, workflows, and pipelines;
3. dashboard, MCP integrations, GitHub, WhatsApp, usage, and audit storage.

The repository was synced first (`8df9d45`, the upstream tip at audit start).
The audit includes the current dirty working tree, because those edits are the
state Junior would run from locally. Existing changes were not modified. A
finding was retained only where a live lesson mapped to current source evidence;
historical claims already fixed in the working tree were excluded.

Severity means:

- **Critical:** untrusted input reaches ambient agent authority.
- **High:** security, data-loss, indefinite-stall, or core task-input failure.
- **Medium:** correctness, operability, measurement, or boundedness gap.

## Summary

| Severity | Count |
|---|---:|
| Critical | 1 |
| High | 13 |
| Medium | 11 |
| **Total** | **25** |

## Findings

### Critical

#### F01 — Memory consolidation runs untrusted Slack content with ambient agent authority

- **Lesson:** `lesson-lock-down-llm-subprocess-untrusted-content` — headless
  LLM subprocesses that consume untrusted content need tools disabled, neutral
  project context, and user hooks disabled.
- **Feature:** memory v3 consolidation.
- **Evidence:** `src/memory/consolidation/runner.ts:208-212` launches Claude
  without a neutral cwd, tool denial, strict/no MCP configuration, or hook
  suppression. The default OpenCode path at `runner.ts:30-31,296-302` also uses
  ambient cwd/config. Raw source-record bodies enter the prompt at
  `src/memory/consolidation/prompt.ts:81-94`. Only the Codex path is isolated.
- **Impact:** a Slack message can act as prompt injection against inherited
  project/user tools and MCP authority.
- **Required change:** apply the hardened pre-recall isolation contract to all
  consolidation providers and add adversarial provider-argument/live probes.

### High

#### F02 — Retrieval-text rewriting has the same ambient-authority exposure

- **Lesson:** `lesson-lock-down-llm-subprocess-untrusted-content`.
- **Feature:** `memory:reembed` retrieval-text Composer.
- **Evidence:** `src/memory/reembed-retrieval.ts:261-273` labels corpus text as
  untrusted, but `:306-323` launches `cursor-agent` in ambient cwd/config with no
  tool or hook isolation.
- **Required change:** use an isolated no-tools runner; if Cursor cannot provide
  that contract, replace it with the hardened runner boundary.

#### F03 — Default durable routing drops Slack attachments

- **Lesson:** `claim_junior-s-durable-default-run-routing-currently-d_bea6cffb`
  — default-run assignment/outbox conversion must preserve `event.files`.
- **Feature:** default durable run routing.
- **Evidence:** `src/session/manager.ts:3902-3904` contains the explicit TODO;
  assignment payloads at `:3994-4027` contain no files. The pump reconstructs
  text/provenance only (`src/pipelines/pump.ts:246-293`), and synthetic events
  omit files (`src/pipelines/dispatch.ts:191-204`).
- **Impact:** images and documents attached to ordinary Slack tasks disappear
  before the runner sees them.
- **Required change:** persist bounded attachment references in assignment/outbox
  state, restore them on dispatch, and cover the full route with an integration
  test.

#### F04 — Agent definitions gain authority without default-branch provenance

- **Lesson:** `git-pinned-registry-must-verify-provenance` — authority-bearing
  disk definitions must be verified against the default branch, not HEAD.
- **Feature:** trusted agent catalog and handoffs.
- **Evidence:** `src/agents/manifest.ts:346-364,451-456` reads and activates all
  on-disk definitions, including operational authority, without a default-branch
  blob comparison.
- **Required change:** mark local/branch-only definitions unpublished and fail
  closed for authority-bearing changes until the blob is default-branch pinned.

#### F05 — Workflow definitions are schedulable without default-branch provenance

- **Lesson:** `git-pinned-registry-must-verify-provenance`.
- **Feature:** dynamic workflows.
- **Evidence:** `src/workflows/registry.ts:115-148` activates disk files;
  `src/workflows/definition.ts:144-160` records a content hash/path/root but no
  verified default-branch commit.
- **Required change:** default-branch verify public and overlay definitions,
  keep unpublished definitions inactive, and persist verified SHA on runs.

#### F06 — Codex app-server leaves the default local environment enabled

- **Lesson:** `codex-app-server-empty-environments-for-tool-isolation` — send
  `environments: []` on both start and resume, then prove dynamic-tool-only
  isolation with live positive and negative probes.
- **Feature:** Codex app-server provider.
- **Evidence:** `src/codex-app-server/spawner.ts:236-254,404` sends neither
  `thread/start` nor `thread/resume` with an empty environments list.
- **Impact:** read-only sandbox policy alone does not remove the built-in command
  tool.
- **Required change:** send `environments: []` on both calls and release-gate a
  permitted dynamic-tool probe plus a forced-shell denial probe.

#### F07 — Worktree Git and setup subprocesses have no hard bound

- **Lesson:** `killing-a-child-does-not-bound-a-timeout-if-grandchildren-hold-the-pipes`.
- **Feature:** worktree creation/setup.
- **Evidence:** `src/worktree/manager.ts:306` waits for Git exit with no timeout
  or noninteractive Git environment; `:338` drains command pipes but provides no
  hard timeout/process-tree termination.
- **Required change:** centralize bounded execution, terminate process groups,
  bound pipe drains, and set `GIT_TERMINAL_PROMPT=0`, batch-mode SSH, and an empty
  credential helper.

#### F08 — Action-button cleanup can destroy ignored dotenv state

- **Lesson:** `worktree-prune-preserve-env-variables` — enumerate and preserve
  ignored dotenv assignments before removing a worktree.
- **Feature:** Slack worktree cleanup action.
- **Evidence:** `src/slack/action-buttons.ts:214-226` checks only porcelain Git
  status; ignored `.env` files are invisible, after which removal is forced.
- **Required change:** use the prune path's dotenv-preservation discipline or
  conservatively skip cleanup when ignored dotenv state exists.

#### F09 — Pre-recall subprocesses bypass runner secret sentinels

- **Lesson:** `runner-secret-sentinels-dotenv-persistence` — sensitive keys must
  be explicitly blanked because child runtimes can reload missing values from
  dotenv files.
- **Feature:** pre-recall provider subprocesses.
- **Evidence:** Claude inherits the environment at
  `src/memory/pre-recall.ts:705`; OpenCode copies `process.env` at `:751`; Codex
  inherits it at `:794`. None uses Junior's sterile runner environment builder.
- **Required change:** share one sentinel-enforcing environment builder across
  all pre-recall providers and test from a cwd containing a hostile `.env`.

#### F10 — Pre-recall buffers unlimited child output in memory

- **Lesson:** `stream-child-output-with-bounded-memory` — drain incrementally;
  full `Response.text()` buffering remains an OOM risk.
- **Feature:** pre-recall subprocess handling.
- **Evidence:** `src/memory/pre-recall.ts:917,927` buffers complete stdout and
  stderr.
- **Required change:** stream to bounded tails/restricted transcripts and test
  output larger than OS pipe capacity.

#### F11 — Orphan repair clears state without terminating descendants

- **Lesson:** `killing-a-child-does-not-bound-a-timeout-if-grandchildren-hold-the-pipes`.
- **Feature:** lifecycle orphan detection.
- **Evidence:** `src/lifecycle/health.ts:24-43` probes only the recorded PID and
  marks the session idle/failed; it never terminates a surviving process group.
- **Required change:** terminate the recorded process group before clearing
  state and test a helper that survives its leader.

#### F12 — Remote OAuth MCP servers are injected into every Claude run

- **Lesson:** `remote-oauth-mcp-wiring` — gate Figma/Notion per agent through
  `wantsMcp`, rather than widening all runs and user setting sources.
- **Feature:** Claude MCP wiring.
- **Evidence:** `src/claude/spawner.ts:245` always adds Figma/Notion;
  `src/runners/mcp-config.ts:61` always returns true; `src/claude/spawner.ts:59`
  widens every run to user settings.
- **Required change:** make both server injection and settings-source widening
  session/agent aware.

#### F13 — GitHub operations can inherit the wrong identity

- **Lesson:** `github-tools-pin-repo-authorized-identity` — GitHub integrations
  must use the exact repository-configured identity.
- **Feature:** GitHub reconciliation/review writes.
- **Evidence:** `src/github/auth.ts:53` returns no environment when `githubUser`
  is absent and never selects an isolated `GH_CONFIG_DIR`;
  `src/github/client.ts:141` then invokes `gh` with ambient auth;
  `src/github/review-comments.ts:622` copies `process.env` on a missing mapping.
- **Required change:** require a repo identity, isolate `GH_CONFIG_DIR`, strip
  inherited auth variables, verify `gh api user`, and fail closed.

#### F14 — GitHub subprocess output is unbounded

- **Lesson:** `stream-child-output-with-bounded-memory`.
- **Feature:** GitHub CLI client and review pagination.
- **Evidence:** `src/github/auth.ts:130`, `src/github/client.ts:111`, and
  `src/github/review-comments.ts:605` buffer complete stdout/stderr; review calls
  can use `--paginate --slurp`.
- **Required change:** stream with byte/page caps, retain bounded error tails,
  and parse pagination incrementally.

### Medium

#### F15 — Worktree removal reports success without proving removal

- **Lesson:** `git-worktree-remove-gitignored-leftovers` — verify both registry
  removal and filesystem absence because removal is non-atomic.
- **Feature:** worktree manager and cleanup action.
- **Evidence:** `src/worktree/manager.ts:158` does no postcondition check, while
  `src/slack/action-buttons.ts:228` reports success.
- **Required change:** verify `git worktree list --porcelain` and path absence;
  report partial cleanup explicitly.

#### F16 — Pre-recall cannot measure whether recalled lessons helped

- **Lesson:** `pre-recall-measure-usefulness-not-injection` — injection/usage is
  not usefulness; persist candidates, selections, and post-turn labels.
- **Feature:** automatic pre-recall.
- **Evidence:** `src/memory/pre-recall.ts:301,596` queries raw input correctly
  but only marks surfaced IDs used. The injected block omits claim IDs and no
  per-turn usefulness record exists.
- **Required change:** persist candidate/selected IDs and a post-turn
  helpful/unhelpful judgment.

#### F17 — Cross-thread Slack permalinks are not resolved before dispatch

- **Lesson:** `resolve-cross-thread-slack-permalinks-before-runner-dispatch`.
- **Feature:** Slack ingress/thread context.
- **Evidence:** `src/slack/events.ts:255` forwards text/files and
  `src/session/manager.ts:2363` receives raw text; neither path deterministically
  parses and resolves workspace permalinks.
- **Required change:** fetch bounded referenced thread context server-side and
  inject it before runner dispatch.

#### F18 — Slack deployment identity is not pinned and revalidated

- **Lesson:** `slack-credentials-are-deployment-identity` — validate token user,
  visible app identity, and joined channels independently of persona.
- **Feature:** Slack startup.
- **Evidence:** `src/index.ts:805` calls only `auth.test()` and stores IDs; it
  does not resolve `users.info`, enumerate membership, or compare a pinned name.
- **Required change:** add setup/doctor identity and channel verification, then
  compare it at startup.

#### F19 — Profile storage is cwd-relative while the memory DB is configurable

- **Lesson:** `gitignore-runtime-pii-outputs-before-agents-commit` — runtime PII
  outputs paired with a DB should use the same absolute, environment-resolved
  configuration discipline.
- **Feature:** keyed memory profiles.
- **Evidence:** `src/memory/profiles/store.ts:27-30,83-85` defaults to relative
  `data/profiles`; the DB uses `MEMORY_DB_PATH` (`src/config.ts:379`). Default
  profile factories are used from `src/index.ts:98`, workflow execution, and
  pre-recall.
- **Required change:** add an absolute `MEMORY_PROFILE_ROOT`, wire every factory,
  and test continuity across cwd changes.

#### F20 — Claim decay exists but has no production caller

- **Lesson:** `safety-net-has-a-caller-before-relying-on-it`.
- **Feature:** memory v3 forgetting/retirement.
- **Evidence:** `src/memory/sqlite.ts:54-60` documents the gap;
  `archiveStaleClaims` at `:1110-1131` has no non-test caller. The feature doc
  also records it as unwired.
- **Required change:** add a report-first scheduled workflow and an explicit
  apply gate with owned thresholds.

#### F21 — Memory retrieval evaluation bypasses the production contract

- **Lesson:** `evaluate-memory-recall-with-full-historical-contract`.
- **Feature:** lesson retrieval benchmark.
- **Evidence:** `src/memory/lesson-retrieval-benchmark.ts:15-59,152-155` ranks
  in-memory fixtures and explicitly remains a mock; it does not pass through
  `upsertClaim`, `recallClaims`, production filters, floors, or final answer use.
- **Required change:** add a historical replay harness over the real write/read
  boundary and score stable answer-level usefulness.

#### F22 — Spend aggregation fetches every usage row

- **Lesson:** `lesson_vetted_ffda7cb7426f_dashboard_aggregation_over_fetch_all`
  — aggregates should be computed in the database, not from `SELECT *`.
- **Feature:** dashboard spend view.
- **Evidence:** `src/usage/store/sqlite.ts:157,165` performs an unbounded list and
  aggregates in process; `src/http/routes/spend.ts:41` invokes it.
- **Required change:** use SQL `COUNT`/`SUM`/`GROUP BY` with the same projection.

#### F23 — Dashboard memory recall silently discards requested kinds

- **Lesson:** `junior-rules-recall-all-claim-kinds` — broad claim kinds and fact
  subtypes form a union; do not interpret only one selected kind.
- **Feature:** dashboard memory recall API.
- **Evidence:** `src/http/routes/memory.ts:70` parses all kinds but `:84` passes
  only `kinds[0]`.
- **Required change:** query/merge all selected kinds and add a multi-kind
  regression test.

#### F24 — `promotion_record` cannot seed a usable runbook intent

- **Lesson:** `claim_junior-s-promotion-record-mcp-currently-records_cf97d51e`.
- **Feature:** MCP runbook promotion.
- **Evidence:** `src/mcp/slack-server.ts:1368-1383` accepts no request text;
  `src/runbooks/promotion.ts:19` stores an empty intent, and
  `src/runbooks/authoring.ts:39` cannot derive the proposal name.
- **Required change:** require request text or derive it from authoritative run
  evidence; test promotion through proposal end to end.

#### F25 — MongoDB proxy exposes capped reads without an export path

- **Lesson:** `mongodb-mcp-find-caps-at-100-use-export` — broad reads must use
  export rather than silently accepting the server's capped `find` result.
- **Feature:** MongoDB MCP proxy.
- **Evidence:** `src/mcp/mongodb-proxy.ts:19` allowlists `find` but not export;
  `:80` forwards allowed calls unchanged.
- **Required change:** expose a constrained schema-preserving export tool or
  reject broad finds that would return partial results.

## Verified areas with no finding

- Normal session dedupe, buffering, and drain behavior.
- Main runner credential sentinels and Claude cwd-affinity resume checks.
- Pipeline managed-worktree binding, transactional outbox/lease recovery,
  historical unique-index healing, and explicit `needs-human` recovery.
- Graceful shutdown process-tree termination and the scheduled prune path's
  dotenv skip/post-removal checks (the Slack action path is the divergent one).
- Task-route identity/upsert/fetch bookkeeping.
- Profile/claim retrieval split, raw episode exclusion from hot-path recall,
  WAL-safe re-embed backups, and hardened pre-recall prompt isolation flags
  apart from the environment/output/measurement findings above.
- WhatsApp authorization and untrusted-content boundaries.
- Audit-store mapping/limits, usage record gating, dashboard traversal and
  loopback/CORS posture, dashboard JavaScript parse checks, and embedding-index
  publication.

## Verification

- `bun run typecheck`: passed.
- Dashboard/integration focused tests run by the audit agent: 67 passed, 0 failed.
- This was an audit-only change: no production source was modified.

The successful typecheck does not contradict the findings: most are authority,
runtime integration, boundedness, and postcondition gaps outside TypeScript's
static guarantees.
