# Adaptive Bug Pipeline

## Problem

The current bug pipeline is too rigid. Lead and the worker agents treat the pipeline as a fixed state machine: intake, observability, reproduction, thinker, review, validation, merge. That produces a consistent audit trail, but it also makes Junior spend time on steps that cannot change the decision.

**Who has this problem:** Humans watching `#bugs-backlog`, lead, reproducer, thinker, and review.
**What happens today:** Lead religiously follows the pipeline. Reproducer, thinker, review, and observability agents also run their full rituals even when the report is already clear.
**Painful part:** The model is not deciding which evidence is needed. It is executing ceremony. A clear backend API bug may still trigger frontend/deploy checks. A screenshot that already identifies a member-facing issue may be misrouted because an admin URL was provided only to identify the user.
**"Finally" moment:** Lead reads the report, separates identity evidence from bug-surface evidence, recalls prior resolved bug patterns, chooses the lightest sufficient path, explicitly skips irrelevant agents, and dispatches workers with mode-specific instructions.

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
| `clear-code-bug` | Exact failing code surface/endpoint is known and reproduction would not add useful evidence | thinker |
| `backend-api-bug` | Backend endpoint response is wrong or failing and frontend only forwards/displays it | targeted observability, thinker |
| `unclear-readonly-ui-bug` | UI failure is read-only and screenshot/report is insufficient to know the exact failure | targeted observability, reproducer, thinker |
| `writepath-bug` | Failure requires mutation to trigger | targeted observability, thinker; no reproducer |
| `high-risk-systemic` | Broad blast radius, payments, auth, security, data loss, or uncertain production impact | full pipeline plus human gates |

This is a decision table, not a second rigid state machine. Lead can choose a hybrid path, but it must state what it is trying to learn.

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

Lead should include mode, objective, required evidence, skip instructions, and terminal outcomes in every worker prompt.

Example:

```text
!thinker
mode: backend-api-bug
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
mode: expected-behavior-check
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

Full observability should not be an invariant. It is expensive context, not a sacrament.

## Resolved Bug Memory Bank

Junior should create a memory record when a bug is resolved. This helps lead classify future reports quickly and skip unnecessary work.

The primary store should be Junior's memory system. Markdown remains useful for human audit inside the bug folder, but memory is the operational classifier.

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

### Memory Write Timing

Memory should be written at terminal states:

- expected behavior explained
- data issue repaired or handed off
- product bug fixed and reviewed
- product bug rejected as not reproducible with a named blocker
- follow-up filed for systemic issue

Who writes it:

- Lead writes memories for expected behavior, routing lessons, data/support outcomes, and skipped-agent lessons.
- Thinker drafts memories for code root causes and fix patterns.
- Review can add a memory only when it catches a reusable review pattern, not for ordinary PR comments.

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

## Done Means

- Lead selected a path and named skipped checks.
- Workers received mode-specific prompts.
- The investigation reached one of: expected behavior, data issue, product bug, needs-human.
- Resolved outcomes wrote a memory record into Junior memory.
- A markdown `memory.md` was written in the bug folder when human-readable provenance is useful.
