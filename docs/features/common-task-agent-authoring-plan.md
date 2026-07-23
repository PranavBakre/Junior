# Common Task Agents and Runbook Authoring Plan

> **Status (2026-07-22):** Proposed.
>
> Scope: allow Junior to recognize repeated operational work, reuse it safely,
> and propose or create private runbooks and agents without turning semantic
> memory or the runtime database into an unreviewed source of authority.

## Outcome

Junior should stop researching the same operational procedure on every request.
For a repeated task, it should retrieve a deterministic, versioned runbook and
execute it through an existing agent. When a genuinely new role is needed,
Junior should generate a validated pull request in `junior-private-agents`
rather than silently granting itself new authority.

The completed system should support this progression:

```text
first occurrence
  -> perform bounded research
  -> store durable atomic facts/lessons and any confirmed advisory procedure memory

repeated procedure
  -> recall matching procedure memory and linked execution evidence
  -> retrieve a Git-backed parameterized runbook when one exists
  -> execute through its owning agent
  -> record outcome and verification evidence

missing reusable procedure
  -> classify as memory, runbook, agent extension, or new agent
  -> generate a proposal and validation report
  -> open a reviewed private-repo PR
  -> activate the merged version and reload the registry
```

The system is complete when Junior can handle a recurring task such as
"transfer all AI roadmaps from one user to another" without re-deriving the
schema and safe execution sequence, while still requiring an explicit human
gate for the production mutation.

## Decision

Use three different storage layers because they carry different authority:

| Layer | Stores | Authority |
|---|---|---|
| Semantic memory | Atomic facts, corrections, situational lessons, advisory procedure memories | Retrieval and promotion context; never sufficient authority for a mutation |
| Git-backed runbooks | Parameterized procedures, gates, verification, owning agent | Authoritative execution instructions after review |
| Git-backed agents | Role, tools, identity, routing, safety and completion contract | Authoritative capability boundary after review |

SQLite may index definitions and store usage, evaluation, activation, and run
history. It is not the canonical authoring store. A database record must always
point to a repository, path, commit SHA, and content digest for the definition
it represents.

## Why not the alternatives alone?

### Memory only

Memory is useful for facts such as collection names, ownership fields, and
confirmed operational landmines. Junior's existing `procedure` memory kind can
also preserve an ordered procedure before a reviewed runbook exists. Retrieval
is similarity-ranked and procedure memories can be incomplete, stale, or lack
an explicit gate, so memory must not be the only place that defines the steps
or authorization for a production write.

### One agent per repeated request

This creates overlapping agents with nearly identical permissions and routing.
Most repeated tasks are procedures inside an existing role. The AI-roadmap
transfer case belongs to `db-executioner`; it needs a reusable runbook, not a
new Slack identity.

### Definitions stored only in the database

This provides fast activation but weakens normal review, diffs, blame,
branching, rollback, and secret scanning. The database is appropriate as a
derived catalogue and telemetry store, not as the sole source of executable
instructions.

### Reuse dynamic workflows

`src/workflows/*` owns scheduled, command-triggered, and Slack-event automation.
Common task runbooks are invoked inside an agent turn and inherit the turn's
human, repository, and safety context. Keep the two systems separate. A dynamic
workflow may invoke a runbook later, but it must not become the runbook registry.

## Definition layout

Add runbooks to the private overlay:

```text
agents-org/
  <agent-name>.md
  common/
  runbooks/
    <runbook-name>.runbook.md
```

Private runbooks are the initial scope because the motivating procedures name
GrowthX schemas, repositories, internal tools, and operational policies. A
future public `runbooks/` root may use the same schema and overlay precedence.

## Runbook schema

Runbooks are Markdown with validated YAML frontmatter and an instruction body.

```yaml
---
schemaVersion: 1
name: transfer-ai-roadmaps
description: Transfer every AI roadmap owned by one user to another user.
ownerAgent: db-executioner
intent:
  examples:
    - move all AI roadmaps from one account to another
  excludes:
    - transfer arbitrary user-owned data
inputs:
  - name: sourceEmail
    type: email
    required: true
  - name: targetEmail
    type: email
    required: true
risk: production-write
approval:
  required: true
  afterSteps:
    - resolve-users
    - count-roadmaps
capabilities:
  - mongo.read
  - migration.execute
verification:
  required: true
  assertions:
    - source roadmap count is zero
    - target roadmap count increased by the matched count
tags:
  - database
  - ai-roadmaps
---

Resolve the source and target users by exact normalized email. Require exactly
one user for each input. Count the matching `airoadmaps` documents, then present
the exact source ID, target ID, filter, matched count, mutation path, and
rollback story for approval. Execute only after approval and verify both source
and target counts. S3 object keys are not rewritten because access is by key,
not by roadmap owner linkage.
```

Required validation:

- `name` is unique kebab-case and matches the filename.
- `ownerAgent` is registered and dispatchable.
- requested capabilities are a subset of the owner's effective capabilities.
- input types come from an allowlist; unknown fields fail closed.
- `production-write`, credential, access-control, destructive, payment, and
  privacy-sensitive risks require a human gate.
- mutation runbooks declare verification and rollback or irreversibility.
- intent examples do not collide materially with an existing runbook.
- content contains no secrets or credential values.

## Capability bundles

Definitions should reference provider-neutral capability bundles rather than
copying arbitrary tool names from a generated prompt. Initial bundles:

| Capability | Meaning |
|---|---|
| `mongo.read` | Schema, find, count, and aggregate without mutation |
| `migration.inspect` | Read models and migration scripts |
| `migration.execute` | Execute an approved repository migration path |
| `slack.read` | Read the scoped channel or thread |
| `slack.post` | Post non-secret results in the scoped thread |
| `credential.deliver` | Deliver a credential through the approved private channel |
| `github.read` | Read repository and pull-request state |
| `github.propose` | Create a branch and pull request through the approved identity |

The runtime maps bundles to tools. A generated runbook cannot widen its owning
agent. A generated agent cannot use a high-risk bundle until trusted policy and
human review approve it.

## Classification before creation

Junior must search current agents and runbooks before generating anything. It
then classifies the reusable knowledge:

1. **Memory claim** — a durable fact or lesson, or an advisory `procedure`
   memory when ordered steps are worth recalling but do not yet form a reviewed
   execution contract.
2. **Runbook** — a repeated ordered procedure that fits an existing owner's
   capability and safety boundary and needs deterministic, versioned execution.
3. **Agent extension** — the existing role is correct but its routing or
   general contract is missing a class of work.
4. **New agent** — the work needs a distinct tool boundary, safety policy,
   identity, routing intent, or completion contract.
5. **Dynamic workflow** — execution is primarily scheduled, command-driven, or
   event-driven rather than part of a conversational task.

Default to the smallest artifact that captures the reusable behavior. Similar
phrasing alone must not trigger creation.

## Promotion policy

Use evidence rather than a fixed prompt instruction to control catalogue growth:

- First successful occurrence: store confirmed atomic facts and lessons. When
  the ordered sequence itself is durable, also store or refine an advisory
  `procedure` memory with provenance and verification evidence.
- Second occurrence with the same intent and procedure: recall the matching
  procedure memory, record a candidate fingerprint, and link the memory plus
  both executions.
- Third successful occurrence, or an explicit human request: propose a runbook.
- Promote a runbook to a new agent only when its owner cannot safely or clearly
  own the capability.
- Flag definitions with no successful use for 90 days for review; archive them
  through Git rather than deleting their history.

Intent fingerprints should include normalized intent, owner agent, repositories,
capabilities, risk class, approval shape, and verification shape. They must not
contain raw PII, secrets, or entire Slack messages.

## Agent authoring flow

Add a trusted `agent-author` capability available only to Junior's orchestrator.
It creates proposals, not unreviewed authority.

```text
request or promotion signal
  -> search agent and runbook catalogues
  -> retrieve linked execution evidence and relevant facts, lessons, and procedure memory
  -> choose artifact class
  -> render from a constrained template
  -> validate schema, capabilities, routing, safety, and secrets
  -> run fixture/evaluation cases
  -> create branch and PR in junior-private-agents
  -> wait for review and merge
  -> update Junior's agents-org submodule pointer
  -> reload registry and verify search/dispatch visibility
```

The generated PR must include:

- why the artifact is needed and which existing definitions were considered;
- links or durable references to repeated executions;
- positive and negative routing examples;
- requested capabilities and risk classification;
- human gates, verification, and rollback behavior;
- validation and evaluation output;
- any memory claims promoted into deterministic instructions.

No automatic activation before merge. Updating the private repository and
updating Junior's submodule pointer are two explicit, auditable Git operations.

## Registry and database model

Add a provider-neutral runbook registry beside the agent registry. It loads and
validates definitions from fixed roots and retains the last-known-good version
when an edited file is invalid.

Suggested SQLite tables:

```text
definition_catalog
  kind, name, repo, path, commit_sha, content_digest, schema_version,
  enabled, loaded_at, validation_status, validation_errors

definition_runs
  id, kind, name, version_digest, owner_agent, intent_fingerprint,
  risk, status, started_at, completed_at, approval_ref, evidence_refs

definition_evaluations
  id, kind, name, version_digest, fixture, expected_route,
  actual_route, passed, evaluated_at

promotion_candidates
  fingerprint, proposed_kind, occurrence_count, successful_count,
  first_seen_at, last_seen_at, evidence_refs, status
```

The catalogue is rebuilt from Git-backed definitions. Deleting the database
must not delete or alter an agent or runbook.

## Routing and retrieval

Add deterministic runbook retrieval before free-form research when an agent
accepts a task:

1. Normalize the request without retaining raw sensitive values.
2. Filter by owner agent, risk, repo, and declared tags.
3. Rank intent examples and exclusions.
4. Require a minimum confidence and a clear lead over the second candidate.
5. Bind typed inputs from the current thread.
6. If required inputs are missing, ask one precise question.
7. Inject the exact versioned runbook and record its digest in run evidence.
8. If no runbook matches, recall relevant `procedure` memories and their
   provenance before doing new research. Use them as hypotheses to verify, not
   as executable authority or permission for a mutation.

Ambiguous matches fall back to ordinary agent reasoning. Junior must not choose
a high-risk runbook from a weak semantic match.

## Memory interaction

Memory remains active around runbook execution:

- Recall at task start across relevant facts, lessons, and `procedure` memory;
  do not restrict retrieval to lessons alone.
- Retrieve the runbook deterministically from the registry, not from memory.
- Recall again before an irreversible or production-sensitive step.
- Add newly confirmed atomic facts or lessons after execution, and create or
  refine procedure memory only when the ordered sequence was verified.
- Do not copy entire runbooks into memory.
- Do not treat any recalled memory as permission to bypass a declared gate.

When a recalled procedure memory repeatedly succeeds and needs deterministic
execution, the authoring flow may promote it, together with linked facts,
lessons, and run evidence, into a reviewed runbook. The Git version then becomes
authoritative; the procedure memory retains provenance and may help retrieval,
but it does not compete as a second execution source.

## Safety and trust boundaries

- Only Junior and `agents-org` may define or widen operational metadata.
- Target repositories may supply conventions but cannot grant tools, identity,
  persistence, mutation authority, or handoff rights.
- Generated artifacts never contain credential values, raw environment files,
  production connection strings, or unnecessary PII.
- Production writes, destructive actions, credentials, external access,
  payments, and privacy-sensitive operations retain explicit human gates.
- Approval is scoped to the exact runbook version, bound inputs, target,
  projected count, and mutation plan. Changed scope invalidates approval.
- Run evidence records exact definition digest, approval reference, checks,
  affected counts, and verification results.
- Reload failure preserves the last-known-good registry and surfaces the error.
- Core agents cannot be overwritten by private generated agents.

## User experience

Junior should expose compact commands or equivalent dashboard actions:

```text
!agents search <query>
!runbooks search <query>
!runbooks show <name>
!runbooks propose <description>
!agents propose <description>
!definitions status
```

Normal users do not need to know the commands. On a repeated ask, Junior should
say that it found the named procedure, summarize the bound plan, and request
the gate required by that procedure. It should not expose internal memory or
profile contents.

## Implementation plan

### Iteration 0 — fix and document the private overlay contract

- Correct the stale submodule update path in `agents-org/README.md`; the mounted
  path is `agents-org`, not `.claude/agents-org`.
- Document the two-commit activation flow: private repo merge, then parent
  repository submodule pointer update.
- Add fixtures for a valid private agent, invalid identity, duplicate name, and
  registry reload.

**Done when:** a newly merged private agent can be pulled, validated, reloaded,
found by `agent_search`, and dispatched without a process restart.

### Iteration 1 — runbook schema, loader, and validator

- Add runbook types, Markdown loader, fixed-root discovery, validation errors,
  last-known-good reload, and content digests.
- Add capability bundle definitions and subset validation against owner agents.
- Add unit tests for names, inputs, risks, gates, verification, collision, and
  secret scanning.
- Add `runbook_search` and `runbook_get` read-only tools.

**Done when:** `transfer-ai-roadmaps.runbook.md` loads from `agents-org/runbooks`,
is searchable, has a stable digest, and fails closed if its authority widens.

### Iteration 2 — deterministic selection and execution evidence

- Add intent matching with exclusions, confidence threshold, and ambiguity
  fallback.
- Add procedure-memory fallback when no runbook matches, including provenance
  display and an explicit prohibition on treating memory as mutation authority.
- Add procedure-aware recall through the memory CLI and runtime tool so callers
  can filter `procedure` memories directly instead of treating every procedure
  as an undifferentiated fact claim.
- Add typed input binding and redaction.
- Inject the selected runbook into the owning agent's prompt.
- Persist selected digest, risk, approvals, counts, and verification evidence.
- Add end-to-end fixtures for positive, excluded, ambiguous, and missing-input
  requests.

**Done when:** variants of the roadmap-transfer ask consistently select the
same runbook, while unrelated data transfers do not.

### Iteration 3 — promotion candidates

- Derive privacy-safe fingerprints from completed runs.
- Link matching procedure-memory IDs and provenance to each candidate.
- Count successful repeated procedures and link durable evidence references.
- Add deduplication against current runbooks and agents.
- Surface proposals after the configured threshold; do not create files yet.
- Add archive-review reporting for definitions unused for 90 days.

**Done when:** three equivalent successful tasks produce one runbook candidate,
not three agents or duplicated memory paragraphs.

### Iteration 4 — constrained authoring and pull requests

- Add runbook and agent templates.
- Implement the memory/runbook/extension/new-agent/workflow classifier.
- Produce a validation and evaluation report with every proposal.
- Create a branch and PR in `junior-private-agents` through the approved GitHub
  identity and repository policy.
- Require review before merge and activation.

**Done when:** an authorized user can ask Junior to make a recurring procedure
reusable and receive a reviewable private-repo PR with no manual file authoring.

### Iteration 5 — activation and catalogue projection

- Detect or explicitly request merged-definition activation.
- Update the parent repository's `agents-org` submodule pointer through a
  separate reviewed change.
- Reload definitions and verify registry visibility.
- Populate the SQLite catalogue with Git provenance and expose status in the
  dashboard.
- Preserve last-known-good behavior across invalid updates and restarts.

**Done when:** the merged and pinned version is the only version Junior can
execute, and its Git provenance is visible from every run record.

### Iteration 6 — evaluations and controlled automation

- Add positive/negative routing fixture suites to definitions.
- Track selection accuracy, completion, gate compliance, verification success,
  human corrections, and rollback incidents by version digest.
- Allow low-risk runbook PRs to use a lighter approval policy after sustained
  clean evaluation results.
- Keep new agents, widened capabilities, and high-risk procedures human-reviewed.

**Done when:** promotion and retirement decisions use versioned outcome evidence,
not only invocation counts or model confidence.

## Test strategy

### Unit tests

- schema parsing and unknown-field rejection;
- overlay precedence and last-known-good behavior;
- capability subset enforcement;
- risk-to-gate requirements;
- typed input validation and PII redaction;
- intent inclusion, exclusion, collision, and ambiguity;
- content digest and Git provenance stability;
- generated definition secret scanning.

### Integration tests

- load a private runbook and execute it through its owner agent;
- restart and reproduce the same selected digest;
- reject an unreviewed database-only definition;
- reject a runbook that requests more authority than its owner;
- invalidate approval when bound inputs or projected affected count change;
- keep the last-known-good definition when a bad edit is reloaded;
- merge a private definition, update the submodule, reload, and search it.

### Evaluation fixtures

For `transfer-ai-roadmaps`:

- "move my AI roadmaps from A to B" -> select;
- "move all roadmaps in prod from A to B" with prior AI-roadmap context -> select;
- "move one Notion roadmap" -> exclude;
- "transfer every document owned by A" -> exclude;
- missing target email -> select, then ask for the target;
- mutation requested without approval -> plan and wait;
- matched count changes after approval -> invalidate approval and re-plan.

## Rollout

1. Ship read-only loading and search behind `RUNBOOK_REGISTRY_ENABLED=false`.
2. Enable shadow selection and compare it with the agent's actual handling.
3. Enable prompt injection for the single roadmap-transfer runbook.
4. Enable run evidence and promotion candidates.
5. Enable PR generation for an admin allowlist.
6. Expand to other repeated database and account procedures after evaluation.

Rollback is disabling selection and authoring while retaining definitions and
run evidence. Existing agents continue to work without the runbook layer.

## Success metrics

- repeated-research time per covered task;
- percentage of eligible asks selecting the correct runbook;
- false-positive selection rate, especially for high-risk runbooks;
- clarification turns before a complete plan;
- human corrections per definition version;
- gate compliance and read-after-write verification rate;
- duplicate agent/runbook creation attempts prevented;
- median time from proposal to reviewed activation;
- unused and overlapping definitions in the catalogue.

The primary success criterion is not the number of agents Junior creates. It is
the percentage of repeated work completed from a reviewed, correctly selected
procedure without losing safety, provenance, or human control.

## Deferred

- Database-only editing of executable definitions.
- Automatic merge or activation of new agents.
- Community marketplace or cross-organization sharing.
- Arbitrary user-authored tool lists.
- Automatic promotion from one successful occurrence.
- Agent prompt A/B testing beyond routing and safety fixtures.
- Composing several runbooks into a durable multi-agent pipeline; use the
  existing pipeline control plane when work requires persisted handoffs.
