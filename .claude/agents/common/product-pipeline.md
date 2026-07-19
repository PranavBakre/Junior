# Product pipeline (feature delivery)

Appended only when an active ProductRun is bound to the thread. Runtime phase, assignment, revision digest, and PR registrations are authoritative — do not infer stage from filesystem layout or Slack position. Report a typed outcome: `continue_self | handoff | wait | escalate | complete`.

Generic rules already loaded are not restated: memory (core), Task-vs-directive dispatch (orchestrator-dispatch), branch/PR/merge invariants (merge-workflow), repo paths + MCP (runtime-environment). This file is only the product stage contract.

## Stages

```
discovery → spec-drafting → awaiting-product-decision → ready-to-build
→ building → aggregate-verification → pr-open → reviewing ↔ fixing
→ approved → ready-for-human-merge → shipped | needs-human | abandoned
```

| Phase | Who acts | Exit |
|---|---|---|
| discovery | PM (or orchestrator) | problem, scope, users; or skip with recorded reason |
| spec-drafting | PM | acceptance criteria + cut list; optional architect contracts |
| awaiting-product-decision | human | one focused product answer |
| ready-to-build | orchestrator | scoped build/frontend assignments |
| building | build / frontend | code + focused checks + checkpoint commits |
| aggregate-verification | orchestrator | all builders done; full revision vector verified |
| pr-open | orchestrator | every PR registered (role + workstreamKey + head SHA) |
| reviewing | review (read-only) | typed verdict: approved \| changes_requested |
| fixing | responsible builder | new revision digest; gates reopen |
| approved | orchestrator | all required gates on same attempt/SHA |
| ready-for-human-merge | human | protected-branch merges; then shipped |

## Ownership (non-negotiable)

- **PM:** problem, scope, user flow, acceptance criteria, cut list.
- **Architect:** contracts, state/data design, risk, technical verification plan.
- **Builders (build/frontend):** code, focused checks, explicit-path checkpoint commits. No push/PR/merge ownership.
- **Orchestrator:** aggregate verification, push/PR create-or-update, phase transitions.
- **Reviewer:** read-only findings + typed verdict. No product-code edits.
- **Human:** material product decisions, gated external/destructive work, final protected-branch merge.

## Skip PM / architecture

Skip when output cannot change implementation (direct, well-specified `build` / `fix` / `implement`). Controller records the reason. Do not invent a second go-word gate for ordinary scoped work after a direct implementation ask.

## Fan-out and rejoin

Full-stack may fan out `build` + `frontend` (one or more repos). Aggregate verification waits for every required assignment and verifies the complete attempt revision vector before review. Changing any revision member → new digest → all aggregate gates reopen.

## Multi-PR

Register every PR with exact owner/repo/number/role/workstreamKey/expectedHeadSha. Multiple PRs in one repository stay separate resources. Ship only when every required PR association is terminal under policy.

## Review ↔ rework

Changes requested → responsible builder. Unchanged findings without a new revision or evidence → escalate (no infinite loop). New revision → re-review on the new digest.

## Outcomes

Always end a turn with a typed outcome (MCP `pipeline_report_outcome` when available). `wait` must name a condition + deadline. Unauthorized edges and missing PR registration on pr-open completion are rejected by the runtime.
