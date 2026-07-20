# Agent Product-Building and Bug-Debugging Pipeline Implementation Plan

> Status: Phases 0–9 landed (shadow/off by default)
>
> Source audit: [Agent Product-Building and Bug-Debugging Pipeline Audit](../audits/2026-07-19-agent-product-debugging-pipeline.md)
>
> Scope excludes WhatsApp and unrelated local work.
>
> **Rollout:** all controllers and GitHub wakes stay off by default
> (`PIPELINE_RUNTIME_MODE=off`, `BUG_PIPELINE_ENABLED=false`,
> `PRODUCT_PIPELINE_ENABLED=false`, `GITHUB_RECONCILE_ENABLED=false`,
> `GITHUB_EVENT_WAKE_ENABLED=false`). Substrate, recovery, retention GC, and
> `!status` pipeline projection are present; enable controllers only via
> validated flag combinations at boot.

## Outcome

Junior should move from prompt-coordinated personas to a durable multi-agent control plane in which:

- product and bug work survive process restarts, laptop sleep, and model-session loss;
- agents can request bounded handoffs to other agents without using Slack as the execution bus;
- every agent returns a structured `continue`, `handoff`, `wait`, `escalate`, or `complete` outcome;
- the runtime validates authority, dependencies, progress, revision, retry budgets, and terminality before advancing;
- review, validation, checks, merge, and cleanup operate on exact repository, PR, attempt, revision-member, and head-SHA anchors;
- GitHub changes are discovered from the laptop through outbound reconciliation;
- prompts, permissions, and handoff rights have one provider-neutral source of truth.

The implementation is complete when these flows work without a human acting as the ordinary scheduler:

```text
Product:
intake → optional PM/architecture → build/frontend → aggregate verification
→ registered PR set → review ↔ rework → human merge gate → all required merges → cleanup

Bug:
intake → adaptive evidence/diagnosis → optional human risk gate → fix
→ review + validation + checks on one attempt revision vector → dev merge → main merge gate
→ merged → cleanup
```

Humans remain responsible for material product choices and explicitly gated external, destructive, production, credential-bearing, security-sensitive, payment, privacy, and data-repair operations.

## Architectural boundaries

### Keep scheduled workflows separate

Do not extend `src/workflows/*` into the multi-agent task graph. That subsystem executes scheduled, command, or Slack-triggered single-run workflows and has different status, concurrency, artifact, and retry semantics.

Add a separate `src/pipelines/` control plane. Scheduled workflows may eventually create or inspect a pipeline run, but they are not its state store or scheduler.

### Separate model judgment from runtime authority

The model may propose a transition. The runtime must decide whether it is legal and atomically persist the outcome before scheduling another action.

```text
agent outcome
  → authenticate assignment and source agent
  → validate state version, edge, capability, scope, dependencies, revision members, and budget
  → persist outcome + transition + event + dispatch outbox in one transaction
  → return explicit receipt
  → asynchronously dispatch or request human input
```

An LLM response, Slack message, review verdict, or resumable provider session is never canonical workflow state.

### Separate trusted operations from prompt customization

Agent definitions contain two classes of data:

1. Trusted operational metadata: lifecycle, identity, capabilities, mutation policy, handoff graph, pipeline roles, and provider permission intent.
2. Prompt content: role instructions, repository conventions, examples, and stage-specific guidance.

Only Junior and `agents-org` may define or widen operational metadata. Target repositories may supplement prompt content and conventions but must not grant themselves new tools, identities, persistence, mutation authority, or handoff edges.

### Make Slack a projection

Slack remains the human conversation and audit surface. It must not be the only mechanism by which one worker wakes another. Internal assignments, outcomes, waits, external events, and dispatch receipts are persisted independently; Slack posting failure cannot lose work.

## Canonical runtime contracts

Create discriminated, versioned types in `src/pipelines/types.ts`.

```ts
type PipelineRun = ProductRun | BugRun;

type PipelineRunBase = {
  id: string;
  kind: "product" | "bug";
  definitionVersion: number;
  channelId: string;
  threadId: string;
  phase: string;
  status: "active" | "waiting" | "needs-human" | "terminal";
  ownerAgent: string;
  repoRefs: string[];
  acceptanceCriteria: string[];
  artifactRefs: string[];
  blockerRefs: string[];
  activeAttemptId: string | null;
  stateVersion: number;
  deadlineAt: number | null;
  terminalOutcome: "merged" | "shipped" | "expected-behavior" | "not-reproduced" | "abandoned" | null;
};

type AttemptRevisionMember = {
  memberKey: string;
  repoRef: string;
  branch: string;
  headSha: string;
  githubResourceId?: string;
};

type Assignment = {
  id: string;
  runId: string;
  parentAssignmentId: string | null;
  sourceAgent: string | "human" | "system";
  targetAgent: string;
  objective: string;
  contextRefs: string[];
  artifactRefs: string[];
  acceptanceCriteria: string[];
  mutationScope: string[];
  dependsOn: string[];
  attempt: number;
  attemptId: string | null;
  candidateRevisionDigest: string | null;
  deadlineAt: number | null;
  idempotencyKey: string;
};

type AgentOutcome = {
  assignmentId: string;
  expectedRunVersion: number;
  action: "continue_self" | "handoff" | "wait" | "escalate" | "complete";
  status: "progress" | "succeeded" | "expected_behavior" | "not_reproduced" | "blocked" | "failed";
  targetAgent?: string;
  reason: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  blockers: Array<{
    kind: "missing_context" | "missing_authority" | "human_gate" | "unsafe_mutation" | "conflicting_evidence" | "no_progress" | "infra_failure";
    detail: string;
  }>;
  checks: Array<{ name: string; status: "passed" | "failed" | "skipped"; evidenceRef?: string }>;
  confidence?: number; // diagnostic only; never sufficient to satisfy a runtime gate
  progressFingerprint: string;
  nextAssignment?: Omit<Assignment, "id" | "runId" | "sourceAgent">;
};

type GitHubResourceRegistration = {
  runId: string;
  assignmentId: string;
  owner: string;
  repo: string;
  number: number;
  role: "candidate" | "dev-pr" | "main-pr" | "dependency" | "review-target";
  workstreamKey: string;
  attemptId: string | null;
  expectedHeadSha: string;
};

type TransitionReceipt = {
  status: "accepted" | "buffered" | "rejected" | "waiting" | "escalated" | "duplicate";
  runVersion: number;
  assignmentId?: string;
  reason?: string;
};
```

Product and bug phases must be TypeScript unions with explicit transition tables. Do not accept arbitrary phase strings from a model.

## Persistence model

Introduce an ordered migration runner before adding pipeline data:

- `src/storage/migrations.ts`
- `src/storage/migrations/*.ts`
- `src/storage/migrations.test.ts`

Add a `schema_migrations(version, name, applied_at)` table. Record the current ad-hoc schema as baseline version 0 and refuse startup against an unrecognized schema. Each later migration runs in one transaction, is idempotent, and refuses partial startup. Take an operator-visible backup before the first data-rewriting migration. Rollback is configuration-first; additive tables and columns remain in place.

Create a pipeline store under:

- `src/pipelines/store/interface.ts`
- `src/pipelines/store/memory.ts`
- `src/pipelines/store/sqlite.ts`

Use the same configured SQLite database but a separate store and namespace from `src/workflows/*`. Enable foreign keys and retain WAL mode.

### Core tables

```sql
pipeline_runs (
  id, kind, definition_version, channel_id, thread_id,
  phase, status, owner_agent, repo_refs_json,
  acceptance_json, artifact_refs_json, blocker_refs_json,
  active_attempt_id, state_version, deadline_at,
  terminal_outcome, terminal_reason, created_at, updated_at
)

pipeline_attempts (
  id, run_id, ordinal, revision_digest,
  status, invalidated_at, invalidation_reason,
  created_at, finished_at
)

pipeline_attempt_revisions (
  id, attempt_id, member_key, repo_ref, branch, head_sha,
  github_resource_id,
  created_at, updated_at,
  UNIQUE(attempt_id, member_key)
)

pipeline_gates (
  id, run_id, attempt_id, member_key, github_resource_id,
  gate_kind, status, subject_sha, evidence_ref,
  provider, model, agent_name, updated_at
)

pipeline_assignments (
  id, run_id, parent_assignment_id,
  source_agent, target_agent, status,
  objective, context_refs_json, artifact_refs_json,
  acceptance_json, mutation_scope_json, dependencies_json,
  attempt_number, attempt_id, candidate_revision_digest, deadline_at,
  lease_owner, lease_expires_at,
  idempotency_key, created_at, updated_at
)

pipeline_outcomes (
  id, assignment_id, action, status, reason,
  evidence_refs_json, artifact_refs_json, blockers_json,
  checks_json, confidence, progress_fingerprint, created_at
)

pipeline_events (
  id, run_id, sequence, event_type,
  actor_type, actor_id, assignment_id, outcome_id,
  from_phase, to_phase, payload_version, payload_json,
  idempotency_key, occurred_at, observed_at
)

pipeline_outbox (
  id, run_id, assignment_id, event_type,
  payload_json, status, attempts, available_at,
  lease_owner, lease_expires_at, idempotency_key,
  created_at, delivered_at, last_error
)
```

Initially record scoped human approval requests and decisions as immutable `pipeline_events`, using the existing Slack action store for versioned button delivery and deduplication. Add a separate `pipeline_approvals` projection only if independent approval querying, revocation, reuse, or compliance retention becomes a demonstrated requirement.

Required constraints:

- unique assignment, event, and outbox idempotency keys;
- unique `(run_id, sequence)` event ordering;
- one accepted terminal outcome per assignment;
- compare-and-set transitions through `pipeline_runs.state_version`;
- an attempt owns a canonical revision vector sorted by stable `member_key`; each member records `(repo_ref, branch, head_sha, github_resource_id?)`, allowing multiple simultaneous workstreams and PRs in the same repository;
- gates reference `attempt_id`, the applicable revision member or GitHub resource, and `subject_sha`; changing any member of the revision vector invalidates the aggregate attempt gates;
- terminal runs reject mutation except explicit cleanup bookkeeping;
- one active controller implementation owns a run from creation to terminality; `definition_version` is retained for restart compatibility, but concurrent controller implementations are deferred.

Retain full terminal-run event history for 90 days by default. After that, prune delivered outbox payloads and compact verbose event payloads while preserving run summaries, terminal reasons, resource anchors, and migration/audit metadata. Retention must be configurable and GC must never touch active or non-terminal runs.

Do not automatically import the existing historical `support/bugs/**/state.json` files as active work. They are evidence, not a reliable live backlog. During migration, new canonical state may project a read-only `state.json` or Markdown summary for humans, but runtime decisions must never read that projection back as authority.

## Continue, handoff, wait, and escalation policy

Implement a pure validator in `src/pipelines/policy.ts`, with product- and bug-specific policy extensions.

Continue automatically only when all are true:

- the next action is inside the current assignment and declared capability;
- mutation scope and required approvals cover the action;
- dependencies and revision requirements are satisfied;
- the action adds evidence, changes a candidate, or advances a gate;
- no irreversible external or human-gated operation is required;
- the same progress fingerprint is not repeating;
- attempt, delegation, deadline, and parallelism budgets remain.

Escalate when any are true:

- a material product decision has multiple reasonable outcomes;
- authority is missing for production, destructive, credential-bearing, security, privacy, payments, data repair, release, or merge work;
- required evidence remains missing after bounded attempts;
- evidence materially conflicts or required evidence remains insufficient; model-self-reported confidence may inform logs but never controls a gate;
- the same failure/finding fingerprint repeats without a new candidate revision vector or evidence revision;
- a deadline, attempt budget, or handoff budget is exhausted;
- an interrupted turn may have performed an irreversible side effect without a durable acknowledgement.

`wait` must always name a persisted wait condition and deadline. There is no indefinite prose-only waiting state.

A human may explicitly override a non-terminal recommendation such as “continue fixing” or “merge now,” but the runtime must resolve the exact run and GitHub resources, revalidate current heads and required protected-branch rules, record the override as an immutable event, and require any still-applicable destructive, production, release, or merge authorization. Human prose never silently bypasses resource anchoring or safety gates.

## Phased delivery plan

Each phase should be an independently mergeable change. Do not enable a later phase until its dependency and exit criteria are green twice consecutively.

### Phase 0 — Contain unsafe current behavior

Goal: remove the highest-risk coupling before building the new control plane.

Changes:

1. Remove `isApprovedReviewResponse` and the automatic review-settlement cleanup callback from `src/index.ts`.
2. Preserve explicit cleanup in `src/slack/action-buttons.ts`, including existing dirty, unpushed, unsafe-untracked, and busy-agent checks.
3. Do not disable merge/retry actions merely because review approved.
4. Extend `SlackActionButtonSpec` in `src/slack/formatting.ts` with a versioned structured resource anchor for mutating PR actions: repository, PR number, head SHA, expected base, run ID, and expected run revision. Capture the anchor from trusted structured state when available; if the response only contains prose, parse only as a best-effort candidate and revalidate before storing. Do not render a generic merge action when one session contains multiple possible PRs and no exact anchor can be established.
5. Add explicit `permissions.intent` to every public operational agent. Unknown or missing intent must fail closed for reviewer, reproducer, PM, and architect roles, while a temporary explicit compatibility map preserves the current review path until Phase 3 replaces it.
6. Add one provider-neutral `willResume(session, providerConfig)` decision. Prompt construction must inject bounded thread, assignment, artifact, and memory context whenever the effective provider invocation will start fresh. OpenCode `--session` remains enabled when configured.

Files:

- `src/index.ts`
- `src/slack/action-buttons.ts`
- `src/slack/formatting.ts`
- `src/slack/action-store.ts`
- `src/session/manager.ts`
- `src/runners/runtime.ts`
- `.claude/agents/*.md`
- affected tests

Exit criteria:

- approval never removes a worktree;
- explicit cleanup still performs all safety checks;
- multi-PR actions cannot execute without an exact stored target;
- read-only roles are hard-confined where the provider supports it and use documented fail-closed best-effort restrictions elsewhere;
- continuity-disabled OpenCode turns receive bounded context.

Rollback: retain automatic review cleanup removal permanently. Other behavior may be disabled through flags, but unsafe cleanup must not return.

### Phase 1 — Make session persistence atomic

Goal: eliminate parallel fan-out state loss before enabling more concurrency.

Changes:

1. Add `state_version` to `sessions` and `agent_sessions`.
2. Replace `get → mutate snapshot → set` with semantic store mutations such as `mutateThread` and `mutateAgent`.
3. Replace `agent_sessions` delete-and-reinsert with targeted UPSERTs.
4. Dual-write provider session ID, status, pending messages, PID, tmux identity, and activity to targeted per-agent rows and the legacy parent JSON during a soak window.
5. Add a read-authority setting that can switch atomically between legacy JSON and per-agent rows. Compare both representations during the soak and alert on divergence.
6. Make per-agent rows authoritative only after a clean soak. Continue the compatibility write until the minimum rollback-compatible binary version has aged out; remove the parent-JSON copies in a later migration, not in the authority-flip release.
7. Use `BEGIN IMMEDIATE` plus compare-and-set for SQLite. Give the memory store equivalent serialized mutation semantics.
8. Convert mutation sites in `src/session/manager.ts`, `src/support/router.ts`, `src/lifecycle/health.ts`, `src/lifecycle/cleanup.ts`, and `src/slack/action-buttons.ts`.

Files:

- `src/session/types.ts`
- `src/session/store/interface.ts`
- `src/session/store/sqlite.ts`
- `src/session/store/memory.ts`
- `src/session/manager.ts`
- `src/support/router.ts`
- lifecycle and Slack callers

Exit criteria:

- concurrent review and reproducer dispatch preserve both agents;
- concurrent session-ID persistence and pending-message append preserve both changes;
- stale semantic mutations retry against fresh state or return a conflict, never replay an old full snapshot;
- cancel/reset cannot race with a completion callback that resurrects state;
- two store instances against one SQLite file pass the concurrency tests.

Rollback: switch reads back to legacy JSON only while dual-write compatibility is still active. Never roll an old binary onto rows written after its declared compatibility window.

### Phase 2 — Land the durable pipeline substrate

Goal: create canonical ProductRun/BugRun state without changing live routing yet.

Create:

- `src/pipelines/types.ts`
- `src/pipelines/store/*`
- `src/pipelines/transitions.ts`
- `src/pipelines/policy.ts`
- `src/pipelines/outbox.ts`
- `src/pipelines/recovery.ts`
- `src/pipelines/projection.ts`
- `src/time/clock.ts`

Changes:

1. Apply the core pipeline tables and constraints.
2. Add `activePipelineRunId` and `activePipelineKind` to `ThreadSession`, defaulting old rows to null.
3. Implement product and bug transition definitions as pure functions.
4. Implement one transaction that records an outcome, updates its assignment and run, appends events, and enqueues successor work.
5. Inject a clock into controllers, leases, deadlines, polling, backoff, and wake-gap detection; production uses the system clock and tests use a deterministic fake clock.
6. Implement explicit wait conditions, deadlines, attempt budgets, fingerprint detection, and terminal-state immutability.
7. Implement attempt revision vectors across all participating workstreams. Review, validation, and checks bind to the same attempt, applicable revision member/resource, and SHA; a changed member produces a new revision digest and invalidates prior aggregate gates. Multiple members may point to the same repository.
8. Add a read-only human projection for the dashboard and optional Markdown/state artifacts.
9. Implement terminal-history retention and idempotent GC without scanning or mutating active runs.

Exit criteria:

- every legal and illegal transition has a table-driven test;
- duplicate idempotency keys return the existing receipt;
- concurrent transitions yield one commit and one recoverable conflict;
- review SHA A plus validation SHA B cannot pass the aggregate gate;
- a multi-workstream candidate, including multiple PRs in one repository, is represented by one revision vector, and changing any member invalidates all aggregate gates;
- terminal runs cannot advance or clean up twice;
- feature-disabled sessions do not create pipeline rows.

### Phase 3 — Introduce a trusted agent catalog and provider-neutral permissions

Goal: make agent identity, lifecycle, capability, and handoff rights explicit and consistent.

Create:

- `src/agents/manifest.ts`
- `src/agents/registry.ts`
- `src/agents/capabilities.ts`
- `src/runners/policy.ts`

Modify:

- `src/agents/loader.ts`
- `src/support/agents.ts`
- `src/support/directives.ts`
- `src/claude/policy.ts`
- `src/codex-app-server/policy.ts`
- `src/opencode/config.ts`
- `src/opencode/spawner.ts`
- provider policy tests

Register these operational roles:

```text
default / lead: orchestrator
pm: product planner
architect: technical planner
build: backend/general builder
frontend: frontend builder
review: reviewer
reproducer: evidence and validation worker
```

Product roles become persistent and dispatchable without requiring a public Slack identity. Resolve symbolic `orchestrator` to `lead` for support/bug runs and `default` elsewhere.

Initial handoff graph:

```text
pm → architect | build | frontend | orchestrator
architect → build | frontend | orchestrator
build ↔ frontend
build | frontend → review | orchestrator
review → build | frontend | orchestrator
reproducer → build | frontend | review | orchestrator
any role → human escalation
```

Provider-neutral capabilities:

- PM/architect: repository read plus pipeline-scoped artifact writes.
- Review: repository and GitHub review reads/comments; no product-code edits or push.
- Reproducer: browser/read-only product access and pipeline artifact writes; no product-code edits or production mutation.
- Build/frontend: ordinary workspace work inside registered worktrees.
- Merge, release, credentials, production writes, destructive operations, and data repair: independently human-gated.

Claude has no OS-level filesystem sandbox. Do not claim worktree confinement that the provider cannot enforce. Use tool restrictions, registered working directories, capability-scoped MCP operations, and human gates; prefer sandboxed providers where stronger confinement is required.

Compatibility:

- shadow-resolve the new registry alongside `AGENT_IDENTITIES`, `ORCHESTRATOR_AGENTS`, and `WORKER_DISPATCH_ALLOW`;
- log differences;
- keep legacy constants until active legacy sessions age out;
- never allow target-repository prompt overrides to widen trusted operational fields.

Exit criteria:

- PM, architect, build, frontend, review, and reproducer resolve consistently across providers;
- target-repository definitions cannot widen permissions or edges;
- reviewer/reproducer are hard read-only on providers that support enforceable confinement; Claude uses explicit best-effort restrictions, no arbitrary worktree Bash, and human gates rather than claiming an OS guarantee;
- builder permissions allow ordinary scoped work without granting merge or production mutation;
- model/provider identity is persisted on every assignment outcome so reviewer independence can be checked.

Reviewers may inspect code, GitHub state, and evidence and may invoke only a pipeline-owned, allowlisted verification runner. They do not receive arbitrary Bash merely to run tests. If a required check cannot run through that runner, the controller creates a verification assignment for an appropriately confined builder/runner and returns the result as evidence.

### Phase 4 — Replace prose routing with authenticated outcomes and handoffs

Goal: let agents tag one another and let the runtime decide whether to continue, queue, reject, or escalate.

Create:

- `src/pipelines/dispatch.ts`
- `src/pipelines/outcomes.ts`
- `src/pipelines/context.ts`
- `src/pipelines/pump.ts`

Add authenticated MCP/runtime operations:

- `pipeline_get_state`
- `pipeline_report_outcome`
- `pipeline_request_handoff`
- `pipeline_write_artifact`
- `pipeline_register_pr`
- `pipeline_run_check`

Use the existing MCP run context to authenticate source agent, thread, channel, assignment, run ID, and expected state version. `pipeline_write_artifact` may write only to pipeline-owned artifact paths or an assignment's explicitly registered documentation paths.

`pipeline_run_check` invokes a repository-profile allowlisted verification command through a pipeline-owned runner, records stdout/stderr/status as evidence, and does not expose arbitrary shell access to read-only roles.

`pipeline_register_pr` accepts the typed `GitHubResourceRegistration` contract and records a durable registration event. Once GitHub tracking is enabled, an outcome that claims to complete a PR-opening phase is rejected unless every created PR is registered with exact owner, repository, number, role, workstream key, attempt, and expected head SHA. Phase 5 materializes these registrations into tracked resources and performs branch-to-PR discovery only as drift repair, never as the primary identity mechanism.

On an accepted handoff:

1. persist the next assignment and outbox record in the outcome transaction;
2. dispatch internally through `SessionManager`;
3. buffer durably if the target is busy;
4. post a concise Slack audit entry;
5. return `accepted`, `buffered`, `rejected`, `waiting`, `escalated`, or `duplicate` to the source agent.

Legacy compatibility:

- parse existing `!review`/`!reproducer`/other directives into structured assignments behind `PIPELINE_LEGACY_DIRECTIVES_ENABLED`;
- use a shared idempotency key so Slack, pure-response, and MCP copies cannot dispatch twice;
- log every legacy parse;
- do not allow legacy and typed controllers to own the same run concurrently.

Loop policy should use `(run, source, target, progressFingerprint, candidateRevisionDigest)` rather than a global hop count. A changed revision vector or new evidence permits a healthy rework loop; an unchanged fingerprint beyond its phase budget escalates.

Exit criteria:

- PM can hand off to architect;
- architect can fan out build and frontend;
- review can return findings to the responsible builder;
- unauthorized edges are rejected visibly;
- a busy target receives one durable buffered assignment;
- Slack failure does not lose the handoff;
- a crash between transition and dispatch replays the outbox exactly once logically.
- PR-opening completion without exact resource registration is rejected once GitHub tracking is enabled.

### Phase 5 — Track GitHub resources and emit typed events

Goal: discover external GitHub changes from a laptop and prove durable, idempotent observation before any external event can wake an agent.

Create:

- `src/github/types.ts`
- `src/github/client.ts`
- `src/github/queries.ts`
- `src/github/diff.ts`
- `src/github/reconciler.ts`
- `src/github/reconciler.test.ts`

Add:

```sql
github_resources (
  id, kind, owner, repo, number, node_id,
  snapshot_json, last_polled_at, next_poll_at,
  poll_class, consecutive_failures, last_error,
  lease_owner, lease_until, terminal_at,
  created_at, updated_at,
  UNIQUE(owner, repo, number)
)

pipeline_github_resources (
  id, run_id, resource_id, role, workstream_key, attempt_id,
  registered_by_assignment_id, expected_head_sha,
  active, created_at, updated_at,
  UNIQUE(run_id, resource_id, role)
)
```

A session/thread may accumulate multiple runs over time while `activePipelineRunId` keeps at most one controller-owned run active during the initial rollout. Each run may associate with multiple PRs across different repositories or multiple PRs in the same repository. `role` distinguishes candidate, dev, main, dependency, and review-target PRs; `workstream_key` identifies backend, frontend, component, or another stable attempt revision member. The same resource may associate with more than one run when explicitly registered; never infer a target from the session, repository, branch, or latest open PR.

Do not implement generic `consumer_kind`/`consumer_id` subscriptions or per-consumer event masks initially. `pipeline_github_resources` is the required normalized run-to-many-PR association, not an optional optimization. Run controllers consume all typed events for their active associations and filter them by explicit role and phase.

Materialize `pipeline_register_pr` events into `github_resources` plus `pipeline_github_resources`. Persist the opaque GraphQL node ID and batch active PRs through `nodes(ids: ...)`. As drift repair, query a registered repository and branch for an open PR only when a model-created PR registration is missing or incomplete; ambiguous discovery escalates and never chooses the newest PR. Each snapshot includes state, merged/closed timestamps, draft status, base, `headRefOid`, review decision, mergeability, and the latest commit's aggregate check rollup. Do not rely only on PR `updatedAt`, because checks can change independently.

Emit typed semantic differences:

```text
github.pr.head_changed
github.pr.base_changed
github.pr.review_decision_changed
github.pr.checks_changed
github.pr.closed
github.pr.reopened
github.pr.merged
```

Phase 5 persists these semantic differences and proposed reductions in shadow mode but does not advance assignments or deliver wakes. A later controller maps events to run-specific transitions. A head change updates the applicable workstream member of the attempt revision vector and proposes invalidation of the aggregate gates. Checks apply only to the exact resource and matching SHA. Merge on a dev PR and merge on a final/main PR remain distinct events.

Laptop polling policy:

- reconcile every resource with an active run association once at startup before normal dispatch;
- detect a clock gap larger than two intervals and reconcile immediately after laptop wake;
- poll hot resources every 30 seconds while waiting on review/checks/merge;
- poll warm or human-gated resources every two minutes;
- after a terminal snapshot and semantic event are durably committed and consumed by the owning run, deactivate that association without a separate confirmation-poll state machine;
- use sequential batches, request timeouts, rate-limit data, `Retry-After`, exponential backoff with jitter, and a fifteen-minute ceiling;
- disable and alert once on invalid credentials rather than hammering GitHub;
- keep Slack running when GitHub is unavailable.

Use a dedicated read-only fine-grained token through `GITHUB_RECONCILE_TOKEN`; do not reuse a merge-capable `gxt-admin` identity. Restrict configured owner/repository scope. If CLI-based auth is supported as a development fallback, require it explicitly and surface the active account.

Startup order:

1. apply migrations and open stores;
2. reconcile live/dead provider sessions and tmux state;
3. reclaim expired outbox and GitHub leases;
4. materialize pending typed PR registrations;
5. reconcile resources with active run associations;
6. persist snapshots, semantic events, and shadow reduction proposals without wakes;
7. start periodic pumps;
8. accept Slack events.

Exit criteria:

- one session can track multiple PRs across different repositories and multiple PRs in the same repository without ambiguity;
- the same repository may have independently tracked dev, main, component, or rework PRs with distinct roles and heads;
- a PR merged while the laptop is asleep is discovered on startup/wake and emits one semantic event;
- checks completed while Junior was down emit one event for the exact resource and SHA;
- ambiguous branch-to-PR drift repair escalates instead of choosing a target;
- GitHub outage or rate limiting backs off without blocking Slack;
- snapshot update and semantic event insertion are atomic;
- no Phase 5 GitHub event wakes or advances a live assignment.

### Phase 6 — Port the bug pipeline and enable durable wakes

Goal: use the more mature bug workflow to exercise typed waits, dev-server jobs, GitHub wakes, rework, and terminal cleanup before enabling ProductRun.

Create:

- `src/pipelines/bug/definition.ts`
- `src/pipelines/bug/controller.ts`
- `src/pipelines/bug/policy.ts`
- `src/pipelines/bug/context.ts`
- `src/pipelines/bug/projection.ts`
- `src/pipelines/dev-server-jobs.ts`

Start with three typed modes:

```text
expected-behavior
focused-debug
full-investigation
```

Treat data support, known-code failures, and high-risk/systemic cases as explicit policies within those modes until telemetry demonstrates that separate state-machine modes change routing. Every mode records known evidence, required evidence, skipped evidence with reasons, risk class, permitted mutations, deadlines, and terminal outcomes. Low-risk read-only cases may continue automatically. Auth, payments, privacy, data repair, production writes, destructive work, ambiguous product intent, and insufficient diagnosis remain human-gated.

Create a BugRun for explicit `!debug`/`!reproducer` starts or when the existing support router commits to a code/behavior investigation. Do not create one for every ordinary support question. During canary rollout, require explicit starts in the enabled support channel before allowing classified automatic creation.

#### Dev-server jobs

Add a `dev_server_jobs` table containing run, assignment, thread, repo, branch, status, ready URL, lease, deadline, PID, error, and release timestamps.

```text
reproducer requests server
→ assignment returns wait and the job is persisted
→ queue acquires the server/lock
→ ready URL is persisted
→ exact waiting assignment is resumed internally
→ Slack receives informational status only
→ validation completion/failure/cancel/deadline releases once
```

Remove the fixed ten-minute sleep and self-bot ready-message dependency from `src/support/router.ts`. The reproducer must end its turn with a typed wait rather than busy-waiting. On restart, reconcile queued/acquiring/ready jobs with filesystem lock and process state before dispatching.

#### GitHub and Slack wake delivery

Enable reducers and wake delivery for the Phase 5 semantic events. A resource head change updates the applicable workstream member, creates a new revision digest, and invalidates all aggregate gates for the old attempt. A check or merge event advances only its associated run, PR role, exact waiting assignment, and matching SHA.

Socket Mode does not guarantee replay across laptop sleep. Add `pipeline_thread_cursors(run_id PRIMARY KEY, channel_id, thread_id, last_observed_ts, last_catchup_at, updated_at)` for waiting runs. On startup or a detected clock gap, fetch missed thread replies before normal dispatch, convert relevant human decisions into idempotent pipeline events, advance the cursor transactionally, and then reconcile GitHub. Reuse the existing thread-catchup mechanism where possible; never treat a repeated reply as a new approval.

Inject a mandatory `<bug-context>` into each assignment: bug/run ID, absolute artifact directory, phase, adaptive mode, risk, attempt ID, candidate revision digest and repository members, environment, required outputs, allowed mutations, and deadline. Workers must not infer phase from file existence or thread position.

Require review, validation, and GitHub checks on the same attempt revision vector. Write-path bugs still require an executable behavioral gate through fixtures, local/test tenants, mocked adapters, or integration tests; code review alone is not validation.

Retire `src/support/pipeline-guard.ts` only after the typed controller owns every enabled bug run. Keep `state.json` as a projection during rollout, then stop scanning it for control decisions.

Startup/wake order after Phase 6:

1. apply migrations and open stores;
2. reconcile provider sessions and tmux state;
3. reclaim expired outbox, dev-server, and GitHub leases;
4. catch up waiting-run Slack threads;
5. materialize pending PR registrations and reconcile active GitHub resources;
6. reduce resulting events and enqueue exact assignment wakes;
7. start periodic pumps;
8. accept live Slack events.

Exit scenarios:

- expected behavior terminates without code;
- focused and full investigations choose evidence proportionally;
- high-risk/systemic work reaches a named human gate within `full-investigation`;
- `devserver.ready` resumes the exact reproducer without Slack echo;
- validation success, failure, cancellation, and deadline release the lease once;
- review, validation, and checks fan out against one revision vector;
- failed validation returns to rework and invalidates prior gates;
- PR checks or merges during downtime wake the exact assignment once;
- a human decision posted during laptop sleep is caught up and reduced once;
- dev merge and final/main merge remain separate;
- repeated no-progress evidence escalates within budget;
- restart during every phase converges from SQLite state.

### Phase 7 — Build the product pipeline

Create:

- `src/pipelines/product/definition.ts`
- `src/pipelines/product/controller.ts`
- `src/pipelines/product/policy.ts`
- `src/pipelines/product/context.ts`
- `.claude/agents/common/product-pipeline.md`

Stages:

```text
discovery
→ spec-drafting
→ awaiting-product-decision
→ ready-to-build
→ building
→ aggregate-verification
→ pr-open
→ reviewing
→ fixing
→ approved
→ ready-for-human-merge
→ shipped | needs-human | abandoned
```

PM or architecture may be skipped when their output cannot change implementation; the controller records the reason. A well-specified direct `build`, `fix`, or `implement` request authorizes ordinary scoped implementation without a redundant go-word gate.

Ownership:

- PM: problem, scope, user flow, acceptance criteria, and cut list.
- Architect: contracts, state/data design, risk analysis, and technical verification plan.
- Builders: code, focused checks, and explicit-path checkpoint commits.
- Orchestrator: cross-repo aggregate verification, push/PR creation or update, and phase transitions.
- Reviewer: read-only findings and typed verdict.
- Human: material product decisions, gated external/destructive actions, and final protected-branch merge.

Full-stack work may fan out to build and frontend across one or more repositories. Aggregate verification waits for every required assignment and verifies the complete attempt revision vector before review. Every PR created for the attempt is registered with an explicit role; multiple PRs in one repository remain separate resources. Changes requested return to the responsible builder, and changing any repository member creates a new revision digest and reopens all affected aggregate gates.

ProductRun starts only from explicit `!pm`/`!build` commands during canary rollout. Broader natural-language starts require separate routing telemetry and are not part of the first enablement.

Exit scenarios:

- explicit backend feature reaches ready-for-human-merge;
- ambiguous feature asks one focused product question, then continues;
- full-stack feature fans out across repositories and rejoins safely;
- one run tracks multiple PRs in the same repository and across different repositories;
- review → fix → new revision vector → re-review converges;
- unchanged review findings escalate rather than loop;
- the run reaches `shipped` only when every required PR association is terminal under policy; GitHub reconciliation then permits cleanup.

### Phase 8 — Consolidate prompts, ownership, and repository guidance

Goal: make prompts a stage-specific view of runtime truth rather than a second controller.

Changes:

1. Rewrite `.claude/agents/default.md`, `pm.md`, `architect.md`, `build.md`, `frontend.md`, `review.md`, `reproducer.md`, and common profiles around the typed outcome contract.
2. Generate Claude, OpenCode, and Codex prompt surfaces from the same agent catalog and canonical prompt source.
3. Remove retired thinker references and conflicting attribution, commit, PR, approval, and ownership instructions.
4. Make `docs/workflows/ideation.md` and `docs/workflows/building.md` repository-neutral. Discover conventions from the target repository's guidance, package scripts, code, and structured repository profile.
5. Inject only the active phase contract, current assignment, relevant artifacts, repository profile, and bounded history. Do not append the full 50K+ pipeline manual to every worker turn.
6. Start normalized prompt golden tests with the safety-critical provider parity surface: permissions, capabilities, handoff edges, required context, and composed prompt budgets. Add broader wording/semantic normalization only after the typed controllers are stable.

Exit criteria:

- no provider gives an agent different authority or handoff rights;
- no active prompt references a retired role or unavailable tool;
- prompt size stays within an explicit composed budget;
- generic workflows name no product-specific framework or command;
- direct implementation authority and human gates are stated once and agree with runtime enforcement.

### Phase 9 — Recovery, observability, rollout, and legacy retirement

Recovery:

- outbox delivery is at-least-once and every consumer is idempotent;
- expired leases are reclaimed, live leases are not stolen;
- dead runners become `interrupted`, not silently idle;
- if an irreversible side effect might have occurred after the last checkpoint, transition to reconciliation or human escalation instead of blindly continuing;
- model-session resume is an optimization; assignment/run/artifact state is always injected.

Observability:

- expose run, phase, owner, attempt revision vector/digest, associated PR roles and heads, gates, waits, deadline, retry/fingerprint, outbox, GitHub health, Slack catch-up cursor, and last external event in `!status`, Slack Home, and the local dashboard;
- log every transition, rejected transition, legacy directive, dedupe, retry, stale result, and escalation with run and assignment IDs;
- alert once for dead letters, invalid GitHub credentials, stuck waits, and migration failure;
- measure transition conflicts, handoff latency, restart replay, GitHub polling lag/cost, duplicate suppression, loop escalation, and prompt size.

Rollout modes and kill switches:

```text
PIPELINE_RUNTIME_MODE=off|shadow|active
PIPELINE_LEGACY_DIRECTIVES_ENABLED
PRODUCT_PIPELINE_ENABLED
BUG_PIPELINE_ENABLED
GITHUB_RECONCILE_ENABLED
GITHUB_EVENT_WAKE_ENABLED
```

Typed handoffs and the trusted permission compiler are part of activating the pipeline runtime, not independent permanent feature flags. Reject invalid combinations at startup: wakes require reconciliation; either controller requires `PIPELINE_RUNTIME_MODE=active`; shadow mode cannot dispatch, wake, or mutate legacy ownership. Keep GitHub observation and GitHub wake delivery separate because observation can be proven safely before it controls work.

Rollout order:

1. Ship Phase 0 independently.
2. Baseline the existing schema, enable atomic mutations, and dual-write session state to legacy JSON plus per-agent rows.
3. After a clean divergence soak, flip read authority to per-agent rows while retaining compatibility writes through the declared rollback window.
4. Record typed pipeline proposals in `shadow` mode without dispatch; sample them against current Slack/prompt outcomes rather than building a permanent full comparison system.
5. Activate the trusted permission compiler and typed handoff substrate together, with only explicitly enabled controller starts.
   Ordinary Junior/default and `CHANNEL_DEFAULTS` lead threads may also be
   deliberately promoted by the active orchestrator through the authenticated
   `pipeline_start_run` control-plane tool. This remains an explicit agent
   action with a durable reason and source-turn idempotency; message keywords,
   channel membership, and casual one-step asks never start a run by
   themselves. Non-orchestrator channel defaults fail closed.
6. Enable GitHub tracking without wakes for explicitly registered PRs, including sessions with multiple same-repo and cross-repo PRs.
7. Enable GitHub wakes and BugRun for explicit starts in one support channel.
8. Enable ProductRun only for explicit `!pm`/`!build` starts in one channel.
9. Enable low-risk continuation while preserving all high-risk gates.
10. Move each new run to typed control at creation; never dual-control an active run.
11. Remove legacy session compatibility writes only after the rollback window, and retire regex guards, pure-response directive internalization, Slack-send interception, filesystem state scanning, and legacy agent constants only after a stable soak.

Rollback:

- disable the affected controller or wake flag;
- mark its active runs `paused-by-rollback` and retain their event history;
- keep additive schema intact;
- return new threads to legacy routing without moving an existing run between controllers automatically;
- version action payloads so old buttons fail closed with “action no longer available”;
- keep review-triggered cleanup disabled under every rollback.

## Pipeline settlement incident: Claude max-turn exit

The July 20 failure in Slack thread `1784535599.540009` was not 25 separate
errors. Claude used all 25 configured agentic turns and emitted
`result.subtype=error_max_turns` with process exit code 0 immediately after
discovering the PR-registration and outcome tools. Junior discarded the result
subtype, treated exit 0 as success, posted the last intention sentence, and
marked the builder settled even though the exact assignment had no typed
outcome. The delivered outbox row therefore had no settlement acknowledgement
and no restart path.

The required invariant is now: a pipeline invocation is settled only when its
exact assignment gains a new durable typed outcome after that dispatch (or the
run/assignment becomes terminal). Each dispatch carries a trusted run id,
assignment id, dispatch key, and outcome-count baseline. A missing outcome
quietly resumes the same provider session up to two times; a committed outcome
wins even if the provider reaches its turn cap immediately afterward. Exhaustion
records one idempotent `needs-human` escalation and posts one concise Slack
failure. Startup and periodic reconciliation re-wake delivered assignments whose
runners disappeared, using the same bounded budget. Long pipelines remain
unbounded across typed `continue_self` and handoff assignments; the bound is per
assignment invocation, preventing runaway recovery chatter.

Product starts also carry an optional explicit `required_workstreams` list.
Repository identity is the fallback before objective keywords, so a frontend
repository does not become a full-stack build merely because the request says
the backend already supports the feature. Explicit two-stream starts create and
dispatch both backend and frontend assignments idempotently.

## Audit-to-phase coverage

| Audit finding | Owning phase(s) | Proof of completion |
|---|---:|---|
| Review approval destroys workspace | 0, 2 | Cleanup only from terminal transition or explicit human action |
| Parallel fan-out overwrites session state | 1 | Concurrent store tests preserve all agent state |
| Agents cannot tag one another | 3, 4 | Trusted edge accepted internally with durable receipt |
| Runtime permissions contradict prompts | 0, 3 | Provider-parity permission matrix passes |
| Dev-server readiness cannot resume validation | 6 | Exact waiting assignment resumes; lease releases once |
| GitHub cannot wake idle/laptop-sleep workflows | 5, 6 | Shadow reconciliation emits first; BugRun then consumes and wakes exactly once |
| No ProductRun/BugRun task graph | 2, 6, 7 | Restart-safe scenario runs converge |
| Continue/escalate inferred from prose | 2, 4 | Runtime validates typed outcomes and budgets |
| Multiple inconsistent handoff transports | 4, 9 | Typed API is sole controller; legacy paths retired |
| Review/validation not tied to one revision | 2, 6, 7 | Same-attempt revision-vector aggregate gate enforced |
| Adaptive bug design is not active | 6 | Mode-specific scenarios and skip reasons pass |
| Prompt ownership and approval conflict | 3, 6–8 | One enforced ownership contract across providers |
| Generic docs hardcode unrelated conventions | 8 | Repository-neutral lint/golden tests pass |
| Prompt/provider behavior can drift | 3, 8 | Canonical catalog and normalized provider goldens pass |
| Actions are not anchored to exact PR | 0, 4–7 | Typed registration and run-to-many-PR associations are persisted and revalidated |
| Prompt tests check markers, not behavior | 6–9 | Scenario and restart suites cover complete loops |
| Prompt size is excessive | 8 | Final composed prompt budgets pass |
| Historical bug files do not converge | 2, 6, 9 | SQLite is canonical; files are projections only |
| OpenCode fresh/resume mismatch | 0, 8 | Effective `willResume` controls context injection |

## Required test suites

### Unit and store tests

- every legal/illegal product and bug transition;
- stale revision, unauthorized role, unmet dependency, expired approval, and terminal mutation rejection;
- assignment/event/outbox idempotency;
- session and pipeline compare-and-set conflicts;
- legacy/per-agent dual-write divergence, authority flip, and rollback-window compatibility;
- agent registry trust boundaries and handoff graph;
- provider permission compilation;
- attempt revision-vector canonicalization, digesting, and cross-repository invalidation;
- exact PR registration and run-to-many-PR association constraints;
- GitHub query parsing, snapshot diffs, partial errors, rate limits, and backoff;
- dev-server job lease and idempotent release;
- deterministic deadline, lease, backoff, and wake-gap behavior with a fake clock;
- composed prompt semantic and size goldens.

### Integration and restart scenarios

Use fake runners, fake Slack, a fake GitHub GraphQL server, and a real temporary SQLite database. Reconstruct the controller mid-scenario rather than testing only pure functions.

Required scenarios:

1. Parallel review and reproducer sessions persist without overwrite.
2. Transition commits but dispatch crashes; startup outbox replay dispatches once logically.
3. Dispatch succeeds but acknowledgement is lost; duplicate is suppressed.
4. Dev-server queue, acquisition, ready, validation, and release survive restart.
5. PR checks complete while Junior is down; startup reconciliation wakes the exact run and assignment.
6. PR merges during laptop sleep; wake reconciliation reaches terminal workflow state.
7. A human decision posted in Slack during laptop sleep is caught up and consumed once.
8. Changing one member of a multi-workstream revision vector—including one of several members in the same repository—invalidates approval, validation, and checks for the aggregate attempt.
9. Review approval plus failed validation preserves the workspace and returns to rework.
10. Review changes requested returns to the correct builder; a new revision re-reviews successfully.
11. One session tracks multiple PRs across repositories and multiple PRs in one repository; every action executes only against its stored resource anchor.
12. A model-created PR must be registered before PR-opening completion; ambiguous drift discovery escalates.
13. Full-stack product work fans out, waits for all builders, and rejoins against one revision vector.
14. Same fingerprint without new evidence escalates; changed evidence continues.
15. Busy target buffers one assignment and drains once.
16. Human rejects scope expansion; no unauthorized mutation occurs.
17. Human requests an override; exact resources and remaining safety gates are revalidated and the decision is recorded.
18. Provider continuity disabled starts fresh with bounded run/assignment context.
19. Reviewer model/provider independence reroutes or requests an explicit human override.
20. Pipeline mode/controller switches off preserve legacy behavior for new non-pipeline threads.
21. Terminal merge of every required PR association permits cleanup; approval alone never does.

### Verification gate for every implementation slice

Before committing a phase:

1. Read every created or modified file.
2. Run `bun run typecheck`.
3. Run focused tests for the phase.
4. Run the relevant SQLite/restart scenario.
5. Check every phase requirement point by point.
6. Fix any issue and repeat the full relevant pass.
7. Require two consecutive clean passes.

Before enabling a new controller or capability in production, run the full `bun test` suite and a shadow/canary scenario using real Slack plus read-only GitHub access. No phase may enable broader handoff or mutation authority before provider permission parity is verified.

## Suggested merge sequence

Keep changes reviewable and rollback-safe:

1. Safety containment: cleanup, action anchors, permission defaults, and `willResume`.
2. Baseline migration runner, atomic session mutation, dual-write soak, and read-authority flip.
3. Pipeline schema, multi-repository attempt vectors, injected clock, transition engine, and tests in shadow mode.
4. Trusted agent catalog and provider permission compilers.
5. Typed outcome/handoff tools, PR-registration contract, dispatch outbox, and recovery.
6. GitHub resource associations and read-only reconciler in shadow mode.
7. Bug controller, durable dev-server jobs, Slack catch-up, and external-event wake delivery.
8. Product pipeline controller and multi-PR aggregate gates.
9. Incremental prompt/provider consolidation and repository-neutral workflow guidance.
10. Recovery hardening, observability, retention/GC, and legacy retirement.

Each merge should leave Junior operational with all later controls disabled. Avoid a single cross-cutting rewrite: persistence, permissions, dispatch, GitHub, product policy, bug policy, and prompts each need their own rollback and evidence surface.
