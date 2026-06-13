# Adaptive Bug Pipeline

## Problem

The current bug pipeline is too rigid. Lead and the worker agents treat the pipeline as a fixed state machine: intake, observability, reproduction, thinker, review, validation, merge. That produces a consistent audit trail, but it also makes Junior spend time on steps that cannot change the decision.

**Who has this problem:** Humans watching `#bugs-backlog`, lead, reproducer, thinker, and review.
**What happens today:** Lead religiously follows the pipeline. Reproducer, thinker, review, and observability agents also run their full rituals even when the report is already clear.
**Painful part:** The model is not deciding which evidence is needed. It is executing ceremony. A clear backend API bug may still trigger frontend/deploy checks. A screenshot that already identifies a member-facing issue may be misrouted because an admin URL was provided only to identify the user.
**"Finally" moment:** Lead reads the report, separates identity evidence from bug-surface evidence, recalls prior resolved bug patterns, chooses the lightest sufficient path, explicitly skips irrelevant agents, and dispatches workers with mode-specific instructions.

## Relationship To Existing Docs

This document updates the bug-pipeline operating policy. It does not replace the persistent-agent substrate.

- [Persistent Agents](persistent-agents.md) still owns the message bus, orchestrator-owned dispatch with allow-listed worker chains, worker identities, `NO_SLACK_MESSAGE`, and per-agent sessions.
- [Bug Pipeline Worktrees](bug-pipeline-worktrees.md) still owns target-repo worktree isolation.
- [Memory-Informed Agent Selection](memory-informed-agent-selection.md) describes memory as routing evidence; this document applies that idea to resolved bug patterns.
- [Associative Memory MVP](associative-memory.md) remains the storage substrate for reusable bug memories.

The main policy change is that `observability-before-UI` and `every bug goes through reproducer/thinker` stop being universal invariants. They become path-specific choices made by lead. Orchestrator-owned dispatch, allow-listed worker chains, and Slack-thread auditability remain invariants.

## Core Shift

The bug pipeline should be a toolkit, not a conveyor belt.

Current rule:

```text
Every bug goes through the pipeline.
```

Replacement rule:

```text
For every report, choose the lightest path that can reach a defensible conclusion.
Use the full pipeline only when the report is plausibly a product defect that needs code or behavior change.
Skip steps whose output cannot change the next decision, and record why they were skipped.
```

Lead owns this decision. Workers should not independently expand scope back into the full ritual unless the lead's chosen mode is impossible or contradicted by evidence.

## Reinterpreting The Old Categorical Rule

The previous pipeline made "every bug goes through the pipeline" categorical for a real reason: lead had repeatedly bypassed the architecture. In one session, lead read product code, used browser tools, restarted dev servers, wrote a small CSS fix, and never dispatched the persistent workers. The hard rule fixed that failure mode, but it overcorrected.

The durable lesson is narrower:

```text
Lead must not silently become reproducer, thinker, reviewer, or release engineer.
```

That rule should remain categorical. Adaptive routing decides **which roles are needed**; it does not let lead perform those roles inline.

Keep these as hard boundaries:

- Lead may inspect evidence needed to route: images, thread context, bug-folder files, memory, route/domain hints, and narrow read-only data needed to classify support vs bug.
- Lead may skip agents/checks when their output cannot affect the next decision.
- Lead must not implement product fixes.
- Lead must not run broad product-code investigations.
- Lead must not perform full browser reproduction or validation when that work belongs to reproducer.
- Lead must not open/merge PRs except in the explicit merge flow after review/validation gates.

The corrected principle:

```text
Strict role boundaries, adaptive step selection.
```

Rigid role boundaries preserve auditability. Adaptive step selection prevents the audit trail from becoming ceremony.

## Intake Model

Lead should first split the report into evidence classes:

```text
Identity evidence:
- admin URL
- email
- member id
- phone
- internal CRM/admin profile

Bug-surface evidence:
- screenshot/image
- visible app URL/address bar
- page title
- visible copy/toast/error
- endpoint/request id
- product area named by the reporter

Action evidence:
- what the user did
- what they expected
- what actually happened
- whether reaching the failure mutates state

Context evidence:
- affected user state
- deploy/release timing
- known prior bug patterns
- channel/team context
```

Identity evidence must not route the bug by itself. For example, an admin admission URL can identify the affected member while the actual bug is in the member frontend.

## Adaptive Paths

Lead should choose one path before dispatching workers.

| Path | Use when | Typical agents |
|---|---|---|
| `clarify` | Report lacks the bug surface, expected behavior, affected user, or image/context needed to proceed | none; ask one question |
| `screenshot-triage` | Image contains the main signal and may be enough to classify surface/symptom | lead, optionally reproducer in image mode |
| `expected-behavior-check` | The user may be seeing correct gating/eligibility/permission behavior | lead; optional targeted data check |
| `data-support-check` | Likely one-user state inconsistency or entitlement issue | lead or data worker; thinker only if code/rule bug appears |
| `clear-code-bug` | Exact failing code surface/endpoint is already known from reporter evidence, observability, memory, or worker output; reproduction would not add useful evidence | thinker |
| `backend-api-bug` | Backend endpoint response is wrong or failing and frontend only forwards/displays it | targeted observability, thinker |
| `unclear-readonly-ui-bug` | UI failure is read-only and screenshot/report is insufficient to know the exact failure | targeted observability, reproducer, thinker |
| `writepath-bug` | Failure requires mutation to trigger | targeted observability, thinker; no prod reproduction |
| `high-risk-systemic` | Broad blast radius, payments, auth, security, data loss, or uncertain production impact | full pipeline plus human gates |

This is a decision table, not a second rigid state machine. Lead can choose a hybrid path, but it must state what it is trying to learn.

`clear-code-bug` does not mean lead should spelunk through product code until it finds the culprit. Valid sources for "known" are reporter-provided stack traces, exact request IDs/endpoints, observability output, resolved-bug memory, prior worker output, or a human-provided diagnosis.

For `writepath-bug`, the forbidden action is prod-connected mutation. Reproduction can still happen through sandbox/staging replay, fixture-based scripts, pure-function mock-runs, or an explicit human-approved mutation workflow.

## Skip Rules

Lead should skip an agent or sub-agent when that agent's output cannot change the next decision.

Examples:

- Skip `reproducer` when the bug is already clear from an exact backend endpoint, payload, and response.
- Skip `vercel-status` when `gx-client-next` directly calls the backend API and the failure is proven to be the backend response.
- Skip `sentry-fetch` for a pure expected-behavior or one-user data-state check unless frontend exceptions would change the conclusion.
- Skip `nr-research` for a screenshot-only CSS defect with no runtime failure signal.
- Skip `gx-admin-client` investigation when an admin URL was provided only to identify the member.
- Skip full thinker hypothesis generation when the task is only to confirm expected gating or explain why the user is locked.

Every skip should be captured in the bug report or lead summary:

```text
Skipping <agent/check> because <reason>. Its result would not change <next decision>.
```

Skipping is not permission for lead to do the skipped worker's job. If lead skips reproducer because the exact backend API failure is already known, lead should dispatch thinker or finish with a support conclusion; it should not open Playwright and reproduce anyway.

## Lead Dispatch Contract

Lead should include path, worker, worker mode/depth, objective, required evidence, skip instructions, and terminal outcomes in every worker prompt.

Example:

```text
!thinker
path: backend-api-bug
worker: thinker
mode: focused
objective: Root-cause why GET /api/v1/foo returns 500 for member <id>.
known evidence:
- frontend calls backend directly; no Next.js API proxy involved
- reported response: 500 with request_id abc123
- affected user: <id>
skip:
- do not investigate Vercel unless code evidence points to frontend bundle/runtime behavior
- do not run UI reproduction; the failing API is already identified
required checks:
- route handler and service path
- affected user's DB shape
- compare with one known-good record if needed
terminal outcomes:
- code bug with fix scope
- data issue with repair/backfill path
- expected behavior / not a bug
- needs-human with missing evidence
```

Example for the AGS-style report:

```text
path: expected-behavior-check
worker: thinker
mode: triage
objective: Determine whether AGS is correctly locked for the affected member.
identity evidence:
- admin admission URL identifies member <id> / <email>
bug-surface evidence:
- use the screenshot as the source of truth for where the lock appears
skip:
- do not route to gx-admin-client from the admin URL alone
- do not run full UI reproduction unless the screenshot is ambiguous
required checks:
- identify actual product surface from image
- inspect member entitlement/onboarding/AGS state
- compare against unlock rule
terminal outcomes:
- expected behavior with explanation
- one-user data issue
- product rule/UI bug
- needs-human
```

When dispatching reproducer, use reproducer-specific modes:

```text
path: screenshot-triage
worker: reproducer
mode: image-interpretation
objective: Identify the actual product surface and visible failure from the attached screenshot.
skip:
- do not open a browser unless the image is unreadable or ambiguous
terminal outcomes:
- expected-behavior
- product-bug
- needs-human
```

When dispatching review, use review depth:

```text
path: clear-code-bug
worker: review
depth: micro
objective: Review the one-file guard fix for the known null-state bug.
escalate_depth_if:
- auth, payments, data migration, permissions, privacy, or shared query behavior is touched
```

## Lead Data Checks

Lead may perform narrow read-only data checks only to choose between support, expected behavior, data issue, and product-bug routing.

Allowed:

- One affected entity lookup by explicit id/email/request context.
- One known-good comparison record when it is named by memory, the reporter, or a simple deterministic filter.
- Projection-limited reads of fields directly named by the report or known unlock/eligibility rule.
- Count queries only when they estimate whether a pattern is one-user or broad.

Not allowed:

- Broad exploratory joins/aggregations.
- Backfills, repairs, or writes.
- Code tracing through product repos.
- Multi-hop forensic analysis that belongs to thinker or a data worker.
- Drawing a final product-code root cause from data alone.

Lead must record the query purpose in the bug notes:

```text
Data check: read member_data for <member_id> to decide expected gating vs data issue.
Scope: projected onboarding.subscription_plans.GROWTH_PROGRAM only.
Outcome: ...
```

If the needed data check exceeds these limits, dispatch `thinker` in `data-repair` or `triage` mode, or dispatch a dedicated data worker if one exists.

## Canonical Outcomes

All worker-specific outcomes should map to one canonical lead outcome before the next routing decision.

| Canonical outcome | Meaning | Example worker terms |
|---|---|---|
| `expected-behavior` | System is behaving according to product/business rules | expected behavior, correctly gated |
| `support-data-issue` | One-user or bounded data/state issue, not a code defect yet | data-issue, repair-needed |
| `product-bug` | Code/rule/UI/API behavior is wrong and needs a product fix | reproduced, code bug, rule bug |
| `mismatch` | A failure was observed, but not the reported one | mismatch |
| `not-reproduced` | Serious attempt could not trigger the reported behavior | not-reproduced |
| `needs-human` | Missing authority, data, credentials, or product decision | needs-human, blocked |
| `fixed-pending-validation` | Fix exists but has not completed validation/merge lifecycle | review approved, validation pending |
| `resolved` | Final outcome is verified or explicitly accepted by a human | solved, merged, expected behavior explained |

Lead may stop only on `expected-behavior`, `support-data-issue` with a named handoff/repair, `needs-human`, or `resolved`. `mismatch`, `not-reproduced`, and `fixed-pending-validation` require either a next action or an explicit human escalation.

## Worker Modes

Workers need modes so lead can make them lighter or deeper.

### Reproducer

| Mode | Behavior |
|---|---|
| `image-interpretation` | Read attached image(s), identify product surface, visible symptom, route, and ambiguity. No browser walk unless needed. |
| `entitlement-check` | Impersonate or inspect only enough UI/API state to confirm visible gating/permission behavior. |
| `read-only-walk` | Current full reproduction behavior for unclear read-only UI bugs. |
| `validation-lite` | Walk only the user story touched by the fix. |
| `validation-full` | Current full validation behavior when risk or uncertainty is high. |

Reproducer should be allowed to conclude:

```text
expected-behavior
data-issue
product-bug
mismatch
not-reproduced
needs-human
```

It should not be forced to treat every report as a product defect.

### Thinker

| Mode | Behavior |
|---|---|
| `triage` | Decide bug vs expected behavior vs data/support issue. No 3-5 hypothesis requirement. |
| `focused` | Generate 2-3 hypotheses around a known failing condition. |
| `full` | Current 3-5 hypothesis process for ambiguous/high-risk defects. |
| `data-repair` | Identify inconsistent state, affected records, and safe repair/backfill path. |
| `known-fix` | Verify an obvious root cause and scope narrowly. |

Thinker should still resist anchoring, but the depth should match uncertainty. A known endpoint error does not need the same ritual as a cross-system race.

### Review

| Depth | Behavior |
|---|---|
| `micro` | Targeted correctness review for tiny or obvious fixes. |
| `standard` | Current normal review behavior. |
| `deep` | Full six-pass review plus focused security/performance/data migration scrutiny. |

Thinker should specify review depth in its `!review` directive. Lead can override if the risk profile changed.

### Observability

Lead should choose observability scope:

| Scope | Behavior |
|---|---|
| `skip` | No observability. Used for expected behavior, data checks, obvious screenshot/CSS issues. |
| `targeted` | One or two queries around a user, endpoint, request id, or time window. |
| `full` | NR + Sentry + Vercel fan-out. Used for broad, unclear, deploy-sensitive, or high-risk bugs. |

Full observability should not be an invariant. It is expensive context, not a default requirement.

Targeted observability dispatches must name the exact signal:

```yaml
scope: targeted
tool: nr-research
signal: backend request failure
entity:
  user_id: "..."
  request_id: "..."
endpoint: "GET /api/v1/..."
time_window: "30m before to 30m after report timestamp"
success_criteria:
  - matching request found
  - status/error class identified
  - enough evidence to route to thinker or expected behavior
fallback:
  - if no matching request and UI evidence is still ambiguous, escalate to reproducer or full observability
```

If targeted observability is inconclusive, lead should either widen to `full` or choose a different evidence path. It should not treat "no targeted hit" as proof that no bug exists.

## Resolved Bug Memory Bank

Junior should create a memory record when a bug is resolved. This helps lead classify future reports quickly and skip unnecessary work.

The primary store should be Junior's memory system. Markdown remains useful for human audit inside the bug folder, but memory is the operational recall layer that supplies classifier evidence.

```text
Primary: Junior associative memory
- searchable by phrase, route, endpoint, product, collection, repo, and signal
- used during intake as evidence
- supports tags/entities and supersession

Secondary: bug-folder markdown
- support/bugs/<product>/<bug-id>/memory.md
- human-readable provenance and detailed notes
- not the primary retrieval mechanism
```

### Memory Record Shape

```json
{
  "kind": "bug_pattern",
  "title": "Admin member URL is identity evidence, not admin bug surface",
  "signals": [
    "Slack report includes admin.growthx.club/admission?member=",
    "screenshot shows member-facing locked state"
  ],
  "classification": "routing heuristic",
  "product_surface": "member frontend",
  "failure_surface": "entitlement/gating",
  "repos": ["gx-client-next", "gx-backend"],
  "routes": ["admin.growthx.club/admission?member=:id"],
  "endpoints": [],
  "collections": ["users", "member_data"],
  "root_cause": "Admin URL was supplied to identify the affected member; actual bug surface came from screenshot.",
  "resolution": "Lead should inspect image first, then member entitlement state, before routing to a repo.",
  "skip_rules": [
    "Do not route to gx-admin-client from admin URL alone",
    "Skip full reproducer if screenshot plus data proves expected gating"
  ],
  "next_checks": [
    "Extract actual product surface from image",
    "Inspect affected member onboarding/subscription/AGS state",
    "Compare against unlock rule"
  ],
  "confidence": "high"
}
```

For code bugs:

```json
{
  "kind": "bug_pattern",
  "title": "Backend API returns wrong access state for expired plan records",
  "signals": [
    "GET /api/v1/members/products/:productId returns access_status=expired",
    "user has never-paid plan record"
  ],
  "classification": "backend-code-bug",
  "product_surface": "member frontend",
  "failure_surface": "backend API",
  "repos": ["gx-backend"],
  "endpoints": ["GET /api/v1/members/products/:productId"],
  "collections": ["member_data"],
  "root_cause": "Plan records are created before payment; API treated presence of plan record as paid lifecycle.",
  "resolution": "Separate never-paid state from expired paid membership.",
  "skip_rules": [
    "Skip Vercel unless frontend behavior contradicts backend response",
    "Skip reproducer when request id and endpoint response already prove backend failure"
  ],
  "next_checks": [
    "Query member_data subscription plan status",
    "Compare paid expired vs never-paid plan shape"
  ],
  "confidence": "medium"
}
```

### Memory Write Timing And Lifecycle

Memory should be written at terminal states, or as explicitly provisional records during long-running fixes.

Final memory can be written when:

- expected behavior is explained and accepted or no further action is required
- data issue is repaired or handed off with a concrete owner
- product bug is validated and merged, or explicitly accepted by a human without automated validation
- product bug is rejected as not reproducible with a named blocker
- follow-up is filed for a systemic issue

Provisional memory can be written when:

- thinker identifies a likely reusable pattern before merge
- review approves but validation/merge is pending
- lead learns a routing lesson before the product fix lands

Provisional records must include `status: "provisional"` and must not be used as strong classifier evidence until finalized.

Who writes it:

- Lead writes memories for expected behavior, routing lessons, data/support outcomes, and skipped-agent lessons.
- Thinker drafts memories for code root causes and fix patterns.
- Review can add a memory only when it catches a reusable review pattern, not for ordinary PR comments.

Required metadata:

```json
{
  "bug_id": "growthx/abc123",
  "status": "final | provisional | stale",
  "created_at": "2026-06-13T00:00:00Z",
  "created_by": "lead | thinker | review",
  "source_thread": "slack://...",
  "source_files": ["report.md", "reproduction.md", "scoping.md", "review.md"],
  "prs": ["https://github.com/.../pull/123"],
  "commits": ["abc1234"],
  "environment": "prod | staging | local-dev",
  "validation_status": "not-needed | pending | solved | human-accepted | failed",
  "supersedes": [],
  "superseded_by": null,
  "sensitivity": "no-pii | redacted-pii | secret-redacted"
}
```

### Memory Use During Intake

Lead should recall memory before choosing a path:

```text
Input signals:
- screenshot text
- route/domain
- endpoint/request id
- admin/member URL
- affected entity type
- product terms from report

Recall:
- bug_pattern
- routing_memory
- procedure
- lesson

Decision:
- strong match -> use prior pattern as evidence and choose a lighter path
- weak match -> mention as possible precedent, proceed with normal checks
- conflict -> prefer current evidence, record memory as stale if needed
```

Memory is not an auto-fix mechanism. It should influence classification and skip decisions, not override the current report.

Memory should also preserve negative routing lessons from resolved incidents:

- "Admin URL was identity evidence, not bug surface."
- "First reproducible failure was a mismatch; do not scope from it."
- "Backend API failure made Vercel deploy state irrelevant."
- "Expected entitlement behavior; no product fix needed."
- "Lead bypassed worker roles; future lead should dispatch mode X."

These are often more valuable than the code fix itself because they stop future lead turns from taking the wrong path.

## Prompt Changes

### Lead

Replace categorical pipeline language with adaptive routing language:

```text
Choose the lightest sufficient path. Full pipeline is required only when the report is plausibly a product defect and cheaper evidence cannot settle the outcome.
Before dispatching any worker, state:
- selected path
- evidence that drove it
- agents/checks skipped and why
- what decision the next agent must help make
```

Lead should be allowed to do lightweight evidence inspection:

- read images
- identify routes/domains
- inspect bug-folder files
- recall memory
- perform small read-only data checks when they decide expected behavior vs data issue

Lead still should not implement product fixes, run broad code investigations, own browser reproduction, restart dev servers, or validate fixes. Those remain worker responsibilities. If the selected adaptive path requires any of that work, dispatch the right worker with the narrowest useful mode.

Lead's first-turn intake should output or write this minimal decision record:

```yaml
selected_path: backend-api-bug
evidence:
  identity:
    - member_id: "..."
  bug_surface:
    - endpoint: "GET /api/v1/..."
    - visible_error: "..."
skipped:
  reproducer: "Exact failing API response is already known; UI walk cannot change root-cause routing."
  vercel-status: "Frontend calls backend directly; no evidence of bundle/deploy mismatch."
next_action:
  agent: thinker
  mode: focused
  decision_needed: "code bug vs data issue vs expected behavior"
```

### Reproducer

Add mode handling and allow terminal outcomes beyond `reproduced` / `not-reproduced`.

```text
Honor the mode in lead's prompt. Do not perform a full browser walk when mode=image-interpretation or entitlement-check unless required to answer the stated objective.
```

### Thinker

Add depth handling.

```text
Honor lead's requested depth: triage, focused, full, data-repair, known-fix.
Only run the full 3-5 hypothesis ritual when depth=full or when evidence is too ambiguous for the requested lighter mode.
```

### Review

Add review depth.

```text
Honor requested depth: micro, standard, deep.
Escalate depth if the diff touches auth, payments, data migrations, permissions, user privacy, or shared query primitives.
```

## Safety Boundaries

Adaptive does not mean casual.

- Never skip a step because it is inconvenient; skip only because it cannot affect the next decision.
- Never let a skipped agent turn into lead doing that agent's work inline.
- Never reproduce write-path bugs in prod-connected environments.
- Never mutate data without an approved data workflow.
- Never use memory as proof. Use it as a classifier hint.
- Escalate to human when the chosen lightweight path cannot settle the report.
- Treat screenshots/images as first-class evidence. Extract the product surface from the image before routing by URLs supplied for identity or admin lookup.
- Treat credentials and transcript captures as sensitive. Do not commit plaintext credentials, and redact or ignore transcript files that contain secrets before they enter version control.

## Human Gates

Human approval is required before:

- production data mutation or repair
- broad backfills or migrations
- auth, payment, privacy, or permission behavior changes with ambiguous product intent
- replaying write-path reproduction against any non-sandbox environment
- merging when validation is skipped for risk/data-quality reasons
- marking a high-risk systemic bug resolved without automated validation

The lead prompt should name the gate and owner:

```text
needs-human: approve data repair for member <id>.
reason: repair writes onboarding.subscription_plans.GROWTH_PROGRAM.access_status.
owner: <@user>
```

## Implementation Plan

1. Update `lead.md`.
   - Replace the universal pipeline rule with "strict role boundaries, adaptive step selection."
   - Add selected path, skip reasons, and next-decision requirements to intake.
   - Add memory recall before path selection.

2. Update `reproducer.md`.
   - Add `mode` handling.
   - Add `expected-behavior` and `data-issue` outcomes.
   - Clarify that image/entitlement modes do not require full UI walks.

3. Update `thinker.md`.
   - Add `triage`, `focused`, `full`, `data-repair`, and `known-fix` depths.
   - Keep full hypothesis tables for ambiguous/high-risk cases.
   - Allow terminal "not a product bug" and "data/support issue" conclusions.

4. Update `review.md`.
   - Add review depth: `micro`, `standard`, `deep`.
   - Let reviewers escalate depth when the diff touches high-risk areas.

5. Add bug-memory write support.
   - Store compact `bug_pattern` records in Junior memory at terminal states.
   - Optionally write `$BUG_DIR/memory.md` for human audit.
   - Mark stale/superseded memories when a future report contradicts them.

6. Migrate existing resolved bug folders opportunistically.
   - Do not bulk-import every old bug blindly.
   - Promote only cases with clear root cause, resolution, and reusable routing lessons.
   - Redact PII and secrets before memory write.

7. Add tests/fixtures.
   - Lead skips Vercel for backend-direct API bugs.
   - Lead treats admin URLs as identity evidence, not routing evidence.
   - Lead dispatches thinker instead of reproducer for clear API bugs.
   - Lead does not perform worker jobs when skipping a worker.
   - Memory recall can influence path selection without overriding explicit current evidence.

8. Add adoption metrics.
   - skipped-agent rate by path and reason
   - human escalation rate
   - reopen/regression rate after lightweight paths
   - mismatch/not-reproduced rate
   - memory-hit rate and stale-memory corrections

## Done Means

- Lead selected a path and named skipped checks.
- Workers received mode-specific prompts.
- The investigation reached a canonical outcome.
- Resolved outcomes wrote a memory record into Junior memory.
- A markdown `memory.md` was written in the bug folder when human-readable provenance is useful.
