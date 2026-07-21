# Agent Product-Building and Bug-Debugging Pipeline Audit — 2026-07-19

## Scope

This was a read-only audit of Junior's prompts and control plane for:

- product discovery, architecture, implementation, review, and rework;
- bug intake, diagnosis, implementation, validation, and escalation;
- agent-to-agent tagging and handoffs;
- agent continuation versus human escalation decisions;
- persistent sessions, runtime permissions, memory, and workflow state.

WhatsApp work and unrelated untracked files were excluded.

Implementation plan: [Agent Product-Building and Bug-Debugging Pipeline Implementation Plan](../features/agent-product-debugging-pipeline-implementation-plan.md).

## Executive diagnosis

Junior's main limitation is not prompt quality. The repository has detailed role prompts and a strong debugging methodology, but the runtime lacks a durable task graph that lets agents hand off work, continue safely, and escalate deliberately.

Today, product building is a collection of personas and prose conventions rather than an executable pipeline. The bug path is more developed, but most of its state machine is prompt-owned rather than runtime-enforced. Agent handoffs have multiple transports, worker-to-worker dispatch is deliberately disabled, and completion outcomes are unstructured text.

The right architectural shift is:

```text
Agent completes assignment
  → structured outcome
  → atomic transition validator
  → continue self | hand off | wait | escalate | complete
  → durable audit event
  → next agent is resumed or dispatched
```

The model should propose the next transition. Junior's runtime should validate authority, mutation scope, dependencies, revision, idempotency, busy state, and loop safety before executing it.

## Critical findings

### P0 — Review approval can prematurely destroy the workspace

An approved review automatically triggers worktree cleanup:

- `src/index.ts:120-121` classifies any response beginning with `review: approved`.
- `src/index.ts:249-270` invokes cleanup immediately when the review agent settles.
- `src/slack/action-buttons.ts:154-198` removes registered worktrees and clears session paths.

This is unsafe for both product and bug pipelines. Review approval is not a terminal workflow state. It can arrive:

- after validation has failed;
- before the orchestrator merges the dev PR;
- before another agent consumes the reviewed branch;
- while a human still needs the merge or retry actions.

The bug pipeline itself requires review plus validation for read-only bugs (`.claude/agents/common/bug-pipeline.md:163-182`), but cleanup is inferred from review prose alone.

**Recommendation:** clean up only after a typed terminal state such as `merged`, `abandoned`, or explicit human cleanup. Preserve the worktree and actions through review, validation, rework, and merge preparation.

### P0 — Parallel agent fan-out can overwrite persisted session state

Junior deliberately dispatches multiple directives concurrently in `src/support/router.ts:235-257`. Each dispatch independently reads and rewrites the entire thread session in `src/session/manager.ts:247-284`.

The SQLite store then:

- rewrites the complete session JSON (`src/session/store/sqlite.ts:75-92`);
- deletes every per-agent row and reinserts the caller's snapshot (`src/session/store/sqlite.ts:194-221`).

Two parallel agents can both start while one snapshot overwrites the other's session metadata. A process may remain live even though buffering, shutdown, agent-state prompts, and recovery no longer know it exists.

**Recommendation:** add atomic session mutation using a per-thread mutex or optimistic `stateVersion`. Update individual agent rows with UPSERT rather than delete-and-reinsert. Reject and retry stale writes.

### P0 — Agents cannot currently tag one another

Worker-to-worker dispatch is disabled by design:

- `src/support/agents.ts:147-176` grants only a legacy `thinker → review/reproducer` compatibility edge.
- `src/support/agents.ts:186-221` injects a deny-all dispatch block into current workers.
- `src/support/router.ts:208-233` strips unauthorized worker directives.
- `src/mcp/slack-server.ts:647-658` applies the same restriction to `agent_dispatch`.

Product roles are also not represented consistently:

- `lead`, `reproducer`, `review`, and `echo` are core persistent identities (`src/support/agents.ts:18-31`).
- `build`, `frontend`, and `architect` are command-selected top-level modes (`src/session/manager.ts:698-704`).
- `pm` has a prompt but is not a recognized Slack command (`src/slack/commands.ts:7-36`) and is not a persistent identity.
- Directive parsing recognizes only registered persistent identities (`src/support/directives.ts:9-28`).

**Recommendation:** separate agent identity, lifecycle, capability, and handoff policy. An agent should not become dispatchable merely because it has a Slack username, and it should not need a public Slack identity to receive a durable internal assignment.

Use a bounded handoff graph such as:

```text
pm → architect | build | frontend | junior
architect → build | frontend | junior
build ↔ frontend
build | frontend → review
review → build | frontend | junior
reproducer → lead
any role → junior or human escalation
```

### P0 — Runtime permissions contradict prompt guarantees

Public agent definitions omit `permissions.intent`. Under Claude, null intent falls through to unrestricted `bypassPermissions` with no enforced tool allow-list (`src/claude/policy.ts:93-102`). This applies even when the prompt says the agent is read-only, must not write code, or must wait for approval.

OpenCode uses the global permission configuration (`src/opencode/spawner.ts:65-75`), which defaults to `allow` (`src/config.ts:230-245`), rather than translating each agent's declared permission intent.

Prompt rules are not a sufficient security boundary.

**Recommendation:** define provider-neutral capability policy and compile it into Claude, OpenCode, and Codex adapters:

- PM and architect: repository read plus scoped documentation writes.
- Reviewer: source read and GitHub review/comment capability, but no product-code edits or pushes.
- Reproducer: browser/read-only product access plus bug-artifact writes, but no product-code edits or production mutation.
- Builder/frontend: workspace writes only inside registered worktrees.
- Merge, release, credentials, production writes, and destructive operations: separate human-gated capabilities.

### P0 — Bug validation cannot reliably resume after dev-server readiness

The reproducer prompt tells the agent to post `!devserver` and wait (`.claude/agents/reproducer.md:43-48`). Junior later posts `ready` as username `Junior` (`src/support/router.ts:356-369`, `src/support/router.ts:456-465`).

That no-directive self-bot message is discarded by the loop guard (`src/support/router.ts:154-175`), so it resumes neither lead nor reproducer. The dev-server slot is held by a blind ten-minute sleep (`src/support/router.ts:344-377`) rather than being tied to validation completion.

**Recommendation:** make dev-server acquisition a runtime job with a typed result. Persist `waiting_for_devserver`; on `ready`, directly resume the reproducer with resolved URLs. Release the lease on validation completion, failure, cancellation, or deadline.

### P0 — External GitHub state changes cannot wake a workflow

Junior runs on a laptop and receives Slack events through an outbound Socket Mode connection (`src/slack/app.ts:4-16`). It has no GitHub event consumer. Its optional HTTP server is deliberately disabled by default and bound only to `127.0.0.1` (`src/http/server.ts:1-8`, `src/http/server.ts:52-55`), so GitHub cannot deliver an inbound webhook to it.

The runtime accepts work only when Slack, a command, or the local scheduler supplies an event (`src/index.ts:445-480`). A pull request can therefore merge, close, receive a new commit, or finish CI while every agent is idle, without the owning product or bug workflow ever learning that its state changed. Model-session continuity does not solve this: a resumable session preserves conversation, but it is not an external event source.

GitHub does not provide a general WebSocket event stream that Junior can consume in the same way it uses Slack Socket Mode. A public webhook relay would add infrastructure that the current laptop deployment does not have and would still need reconciliation after downtime.

**Recommendation:** make outbound GitHub reconciliation the primary mechanism. Persist every tracked pull request with repository, PR number or node ID, owning workflow/thread, candidate SHA, and last-known external state. While Junior is running, batch-poll tracked non-terminal PRs through GitHub every 30–60 seconds; reconcile immediately at startup and after a detected laptop sleep/wake gap. Convert state differences into typed internal events such as `pr.merged`, `pr.closed_unmerged`, `pr.head_changed`, `checks.passed`, `checks.failed`, `review.approved`, and `review.changes_requested`, then let the owning workflow decide which agent continues or whether to escalate. Webhooks may become a latency optimization if Junior later gains a durable public receiver, but periodic reconciliation remains the recovery path.

## Major design gaps

### P1 — There is no durable product or bug task graph

`AgentSession` stores only provider, session ID, status, pending messages, activity, and PID (`src/session/types.ts:52-65`). Prompt-visible agent state contains only status and pending count (`src/session/manager.ts:1932-1948`).

It does not record:

- assignment and parent task;
- workflow phase and current owner;
- acceptance criteria;
- artifacts and evidence;
- repo, branch, PR, attempt, or candidate SHA;
- blockers and escalation reason;
- dependencies and requested successor;
- progress fingerprint or deadline.

Dynamic workflows do not fill this gap. The executor runs a single runner and produces one result, while multi-step DAGs and retries remain explicitly out of scope (`docs/features/dynamic-workflows.md:240-247`).

**Recommendation:** add a versioned, SQLite-backed `ProductRun`/`BugRun` substrate. Markdown artifacts remain the human audit record, not the control state.

Suggested product stages:

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

Suggested bug stages:

```text
intake
→ route/evidence-plan
→ diagnosis
→ risk or human gate
→ fixing
→ review + validation on the same candidate SHA
→ dev merge
→ ready-for-human-main-merge
→ done | needs-human | abandoned
```

### P1 — Continue versus escalate is inferred from prose and regexes

The pipeline guard recognizes advancement through literal text such as `!reproducer` or `Going with #N`, and accepts broad blocker words including `missing`, `failed`, or `cannot` (`src/support/pipeline-guard.ts:18-77`). It protects only three early statuses and escalates after one failed retry.

Idle recovery unconditionally tells an interrupted runner to continue from its last step (`src/session/manager.ts:1258-1289`, `src/session/manager.ts:1335-1379`), even when a side effect may have occurred without a durable checkpoint.

**Recommendation:** every agent turn ends with a structured outcome. The runtime validates the proposed transition against current version, authority, mutation policy, dependencies, attempts, and progress.

An agent may continue when:

- the next action is within its approved capability and mutation scope;
- dependencies are satisfied;
- the action adds evidence or advances state;
- no human gate or irreversible external action is required;
- delegation and attempt budgets remain;
- the same progress fingerprint is not repeating.

It must escalate when:

- new authority or product judgment is required;
- the next action is destructive, production-mutating, credential-bearing, or externally irreversible;
- required evidence remains missing after bounded attempts;
- evidence materially conflicts or confidence remains below the phase threshold;
- the same blocker/fingerprint repeats without new evidence or a new candidate;
- deadline, attempt, or delegation budgets are exhausted.

### P1 — Handoffs use inconsistent transports

Junior currently has several overlapping handoff mechanisms:

- Slack text directives through `AgentDispatcher`;
- pure final-response directives silently internalized by `SessionManager` (`src/session/manager.ts:1620-1698`);
- the `agent_dispatch` MCP tool calling `SessionManager` directly (`src/mcp/slack-server.ts:603-674`);
- pure directives passed to `slack_send_message`, intercepted before posting (`src/mcp/slack-server.ts:917-970`).

Internalization works only when every non-empty response line is a directive (`src/support/directives.ts:30-40`), and the line format cannot express a multiline structured assignment.

**Recommendation:** use one authenticated, structured handoff API and one durable event log. Slack becomes the human projection of dispatch state rather than the execution transport. Every request receives an explicit `accepted`, `buffered`, `rejected`, `waiting`, or `escalated` receipt; nothing is silently stripped.

### P1 — Review and validation gates are not tied to one revision

Review and validation fan out in parallel (`.claude/agents/common/bug-pipeline.md:138-159`), but their artifacts do not bind results to the same `attemptId` and `candidateSha`. A new commit does not formally invalidate old approval or validation.

**Recommendation:** every candidate revision gets an attempt ID and SHA. Review and validation must report against both. A new commit invalidates both previous gates. Merge requires every required gate to pass against the identical candidate SHA.

### P1 — The active bug prompt contradicts the adaptive design

The live prompt mandates full observability and a hypothesis phase for every bug (`.claude/agents/common/bug-pipeline.md:13-57`). The adaptive design instead calls for the lightest defensible path and explicit skips when evidence cannot change the next decision (`docs/features/adaptive-bug-pipeline.md:12-30`, `docs/features/adaptive-bug-pipeline.md:96-133`).

The adaptive document also still references the retired thinker, so it is not an executable current contract.

**Recommendation:** implement adaptive modes in typed state:

- `expected-behavior`
- `data-support`
- `known-code-failure`
- `focused-debug`
- `full-investigation`
- `high-risk-systemic`

Each decision records selected mode, known evidence, required evidence, skipped checks with reasons, terminal outcomes, and escalation thresholds.

### P1 — Prompts disagree on authority and ownership

Examples:

- Default says code work should edit directly, then says to dispatch it (`.claude/agents/default.md:26-45`).
- Builder requires explicit go-words for implementation (`.claude/agents/build.md:16-23`).
- Generic building docs require a second confirmation before coding (`docs/workflows/building.md:18-31`).
- Builder says it stages, commits, and opens a PR (`.claude/agents/build.md:53-68`).
- Bug Phase 2 says the orchestrator verifies, commits, and opens the PR after the builder returns (`.claude/agents/common/bug-pipeline.md:124-161`).

These contradictions create double gates and ambiguous ownership.

**Recommendation:** adopt one contract:

- Builder/frontend: edit, run focused checks, and create an explicit-path checkpoint commit when authorized by the assignment.
- Orchestrator: aggregate verification, push/PR coordination, transition ownership, and human gates.
- Reviewer: review and typed verdict, never product-code mutation.
- Direct user requests such as “build”, “fix”, or “implement” authorize ordinary scoped workspace work. Escalate only for missing product decisions, expanded scope, destructive/external action, production mutation, or high-risk authority.

### P1 — Generic workflow docs hardcode unrelated repository conventions

`docs/workflows/ideation.md` and `docs/workflows/building.md` prescribe Fastify, Drizzle, Zod, XState, React Query, React Hook Form, and `pnpm -r typecheck`. PM and architect prompts direct agents to these files even when the target repository uses different architecture and commands.

**Recommendation:** make public workflows repository-neutral. Resolve conventions and verification commands from the target repo's guidance, package scripts, feature docs, and a structured repository profile. Move product-specific patterns into the relevant target repository.

### P1 — Prompt and provider behavior can drift

Production OpenCode uses generated prompts rather than `.opencode/agents/*` (`src/opencode/spawner.ts:63-85`). Static OpenCode prompts are manual-development surfaces and already contain retired thinker references. Prompt lint validates `.claude` marker presence but not semantic equivalence across providers.

The bug prompt also tells the orchestrator to append `by junior`, while the runtime identity prompt tells orchestrators not to append attribution (`src/session/manager.ts:1890-1919`).

**Recommendation:** use one canonical agent manifest and prompt source compiled for every provider. Add golden tests that compare normalized role, permission, handoff rights, required context, terminal outcomes, and authority across Claude, OpenCode, and Codex.

### P1 — Action prompts are not anchored to structured targets

The review merge action uses a generic “merge the review-approved PR” prompt. Its action state lacks structured repository, PR number, head SHA, base branch, and verdict identity. Junior memory contains a concrete prior failure where a generic merge action selected the wrong PR in a multi-PR thread.

**Recommendation:** persist and revalidate structured anchors:

```json
{
  "repo": "owner/repo",
  "prNumber": 3295,
  "headSha": "...",
  "expectedBase": "dev",
  "reviewVerdictId": "..."
}
```

Never ask an agent to infer a mutation target from conversational recency.

## Proposed runtime protocol

```ts
type AgentManifest = {
  name: string;
  lifecycle: "persistent" | "stateless";
  identity?: AgentIdentity;
  capabilities: string[];
  mutationPolicy: "none" | "workspace" | "human-gated" | "external";
  handoffPolicy: {
    mayDelegateTo: string[];
    mayReturnTo: string[];
    maxParallel: number;
  };
};

type Assignment = {
  id: string;
  workflowId: string;
  sourceAgent: string | "human" | "system";
  targetAgent: string;
  objective: string;
  contextRefs: string[];
  artifactRefs: string[];
  acceptanceCriteria: string[];
  mutationScope: string[];
  dependsOn: string[];
  attempt: number;
  candidateSha?: string;
  idempotencyKey: string;
};

type AgentOutcome = {
  assignmentId: string;
  action: "continue_self" | "handoff" | "wait" | "escalate" | "complete";
  status:
    | "progress"
    | "succeeded"
    | "expected_behavior"
    | "not_reproduced"
    | "blocked"
    | "failed";
  targetAgent?: string;
  reason: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  blockers: Array<{
    kind:
      | "missing_context"
      | "missing_authority"
      | "human_gate"
      | "unsafe_mutation"
      | "conflicting_evidence"
      | "no_progress"
      | "infra_failure";
    detail: string;
  }>;
  confidence: number;
  progressFingerprint: string;
  nextAssignment?: Omit<Assignment, "id" | "workflowId" | "sourceAgent">;
};
```

The runtime, not the model, validates the outcome, atomically records it, and schedules the next transition.

## OpenCode continuity clarification

OpenCode `--session` support exists and is used when continuity is enabled (`src/opencode/spawner.ts:99-104`). The current local environment has `OPENCODE_CONTINUITY_ENABLED=true`, and the default configured provider is Claude, so context loss is not an active issue in this workspace.

There is still a configuration-safety flaw: the code default sets OpenCode continuity to false (`src/config.ts:230-234`), while prompt construction treats a stored session ID as proof that a later turn will resume (`src/session/manager.ts:1078-1132`). A deployment without the environment override can therefore start a fresh OpenCode model while omitting the first-turn Slack/thread preamble.

**Recommendation:** calculate `willResume` from provider capability and effective continuity settings. If false, treat every turn as fresh and inject bounded thread history, assignment state, artifacts, and memory.

## Verification and audit evidence

Focused tests run:

```text
bun test src/agents/lint.test.ts \
  src/support/agents.test.ts \
  src/support/router.test.ts \
  src/support/pipeline-guard.test.ts \
  src/session/manager.test.ts
```

Result: **172 passed, 0 failed**.

This confirms that most findings are architectural gaps or behaviors currently encoded as expected—not ordinary failing unit tests.

Prompt composition size also matters. The public support-lead prompt is approximately 39.8K characters. With the private common overlay, it is approximately 57.5K characters before Slack thread history, workspace context, memory, and artifacts. The core prompt has a size test, but the final composed prompt does not.

**Recommendation:** inject stage-specific contracts and current assignment state rather than the entire pipeline manual on every turn. Add composed-prompt budget snapshots and scenario tests.

The tracked bug-state snapshot contains 44 `state.json` files: 7 `done` and 37 non-terminal. These files may be historical artifacts rather than live unresolved bugs, so the count is not an operational backlog metric. It is evidence that prompt-owned state does not reliably converge or reconcile.

## Recommended implementation order

1. Remove review-triggered automatic cleanup.
2. Fix atomic session persistence and dev-server continuation.
3. Enforce provider-neutral role permissions.
4. Add durable `ProductRun`/`BugRun`, assignments, outcomes, and atomic transitions.
5. Add authenticated structured handoffs with explicit dispatch receipts.
6. Add outbound GitHub reconciliation for tracked PRs and route typed external events into the owning run.
7. Build the automatic product loop: discovery → approval → build → aggregate verification → PR → review ↔ rework → human merge.
8. Bind review and validation to the same attempt ID and candidate SHA.
9. Port adaptive bug modes into the active orchestrator.
10. Make generic workflow docs repository-neutral.
11. Consolidate prompts and add end-to-end pipeline simulations for restart recovery, duplicate handoffs, busy-agent buffering, review-to-fix loops, dev-server readiness, GitHub changes during laptop sleep, revision-matched gates, timeout escalation, multi-PR action anchoring, and terminal-only cleanup.
# Historical snapshot

> This audit predates the 2026-07-21 documentation and agent-catalog updates.
> It records findings from that point in time; follow the current code indexes
> and [`2026-07-21-documentation.md`](2026-07-21-documentation.md) for live
> behavior.
