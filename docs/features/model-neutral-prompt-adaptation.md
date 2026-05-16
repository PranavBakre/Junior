# Model-Neutral Prompt Adaptation

## Problem

Junior's original prompts assumed Claude Code backed by very strong, large-context Opus-class models. Those prompts leaned on long prose, implicit operational judgment, and large injected context. That worked when the model could hold many rules at once and infer the action behind a Slack message.

When Junior runs on a more direct model with a smaller context budget, two failure modes become more likely:

1. **Action miss:** the model answers with advice or a plan when the user expected it to inspect, edit, test, dispatch, commit, or otherwise act.
2. **Context overload:** important rules are buried in long common preambles, full Slack history, and dense agent prompts, so the model follows the nearest or simplest instruction instead of the governing workflow.

**Finally:** Junior's prompts are provider-neutral, compact, explicit, and procedural. Agents classify the requested action first, receive only the context needed for their role, and follow state-machine style workflows instead of relying on broad inference.

This is a prompt/runtime-behavior project, not a Codex-provider project. OpenCode is the current non-Claude provider. The adaptation target is GPT-5.5-class behavior behind the existing runner path: more literal, more direct, and less tolerant of buried instructions.

OpenCode-specific constraint: Junior now has an OpenCode-specific prompt surface. PR #32 added `.opencode/agents/*`, `opencode.json` instruction wiring, OpenCode tool-use parsing, and duplicate Slack-post suppression. [PranavBakre/Junior#31](https://github.com/PranavBakre/Junior/pull/31) separately explored generated `agent.build.prompt` overrides. The overhaul must reconcile those two approaches instead of letting static OpenCode agents and generated OpenCode prompts drift apart.

Current main after PR #32:

- `.opencode/agents/{lead,thinker,reproducer,review,build,frontend,architect,pm}.md` exists as a first OpenCode agent overlay, but it is not the Junior Slack runtime source of truth unless the generator explicitly reads or mirrors it.
- `opencode.json` now carries no prompt instructions; OpenCode runtime receives `core.md` only through generated `agent.build.prompt`.
- `spawnOpenCode()` generates `OPENCODE_CONFIG_CONTENT` per run with `agent.build.prompt`, `mode = "primary"`, and generated permission/MCP config. Because OpenCode merges config layers, this generated agent config is the runtime-authoritative OpenCode prompt surface.
- `agents-org` is now the org overlay path.
- OpenCode parser/Slack formatting maps tool-use events and suppresses duplicate Slack tool posts more robustly.
- PR #31 still contains useful generated-prompt discovery, but it is no longer the only OpenCode prompt-quality branch.

Implemented in this overhaul so far:

- Public Claude-style agents have provider-neutral frontmatter and selected `common:` profiles.
- `.claude/agents/common/core.md` is the compact universal action/context contract; `orchestrator-dispatch.md` carries delegation rules for coordinator agents.
- `.claude/agents/default.md` is the explicit default Junior orchestrator.
- `AgentRouter` resolves `default` for top-level default runs and loads only profile-selected common files.
- OpenCode runtime uses generated `agent.build.prompt` on provider agent `build`; static `.opencode/agents/*` are marked manual-dev only.
- Generated OpenCode prompts include provider baseline, `<junior-core>`, `<junior-active-agent>`, and the dynamic Junior prompt.

## OpenCode Prompt Audit

Date: 2026-05-16
OpenCode: `1.14.48`

Commands used:

```sh
opencode debug agent lead
env OPENCODE_CONFIG_CONTENT='{"agent":{"lead":{"mode":"primary","permission":{"read":"deny","bash":"allow"},"prompt":"GENERATED_LEAD_PROMPT"}}}' opencode debug agent lead
opencode debug agent build
env OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"mode":"primary","permission":{"*":"allow"},"prompt":"GENERATED_BUILD_PROMPT"}}}' opencode debug agent build
env OPENCODE_CONFIG_CONTENT='{"agent":{"junior":{"mode":"primary","permission":{"*":"allow"},"prompt":"GENERATED_JUNIOR_PROMPT"}}}' opencode debug agent junior
```

Findings:

- Static `.opencode/agents/lead.md` resolves as `native: false`, `mode: subagent`, with the static prompt.
- Generated `OPENCODE_CONFIG_CONTENT` for the same agent name wins for `prompt`, `mode`, and `description`. The generated `lead` config changed the effective prompt to `GENERATED_LEAD_PROMPT` and mode to `primary`.
- Permissions are merged as rule lists, but generated rules affect the effective tool surface. In the generated `lead` test, `read` became unavailable even though the static lead file allowed it.
- Static `.opencode/agents/build.md` resolves as `native: true`, `mode: primary`.
- Generated `agent.build.prompt` also stays `native: true`; overriding `build` preserves OpenCode's native build-agent surface.
- Custom generated agents such as `junior` resolve as `native: false`.

Conclusion:

- Junior runtime should treat generated `OPENCODE_CONFIG_CONTENT` as the source of truth for OpenCode runs.
- The runtime should use `--agent build` with generated `agent.build.prompt` unless a later test proves a non-build native agent exists for the needed role.
- `.opencode/agents/*` should not be treated as runtime-authoritative unless the generator reads them. They can remain as local-dev/manual OpenCode prompts, or become source files for the generator, but they must not drift silently from generated runtime prompts.
- The main OpenCode agent must still be able to parallelize work through Task/sub-agents or persistent Slack directives. Using provider agent `build` is only the native-tool surface choice; it must not collapse Junior back into one context-heavy monolithic turn.

## Design Principles

1. **Provider-neutral prompts.** Agent files should not assume `opus`, Claude-only behavior, or a specific context window.
2. **Action before explanation.** If the user asks for work, the agent performs work. It only returns a plan when the user asked for a plan, the operation is unsafe, or required context is missing.
3. **Checklists over prose.** Prefer numbered workflows, decision tables, and output templates over long philosophical paragraphs.
4. **Context is a budget.** Inject the smallest useful context for the current agent and turn. Long Slack history should be summarized or tailed, not pasted wholesale by default.
5. **One source of truth per rule.** Common invariants belong in small targeted preambles; large reference material should be injected only for agents that need it.
6. **Delegate to manage context.** A smaller context window means Junior should split independent work into bounded agents earlier, not try to hold every repo, trace, and decision in one turn.
7. **Provider agent name is not the orchestration model.** Running OpenCode through provider agent `build` preserves native behavior, but Junior's generated prompt must still instruct the main agent to fan out independent work via Task/sub-agents or persistent agents.

## Required Changes

### 1. Remove Opus-specific frontmatter

Current public agents include entries like:

```yaml
model: opus
```

Replace these with either no model field or a provider-neutral tier:

```yaml
modelTier: strong
```

Junior's runtime config should map the tier to the actual configured provider/model. Agent definitions should describe capability needs, not a concrete vendor model.

### 2. Add an explicit intent/action classifier

Add this to the always-injected core prompt:

```md
## First step: infer the required action

Before responding, classify the user's message:

1. **Answer only** — user asks for explanation, opinion, or a plan.
2. **Act now** — user asks to inspect, edit, run, commit, open a PR, review, verify, dispatch an agent, or update a document.
3. **Ask first** — the action is destructive, ambiguous, outside the workspace, or missing required context.

If action is required, do the action. Do not merely describe how to do it.
If answering only, keep it concise.
```

This directly addresses the lower-model tendency to respond literally instead of performing the implied operation.

Add concrete trigger examples below the classifier. These examples matter because GPT-style failures are often literal-action misses:

| User shape | Required action |
|---|---|
| "can you check X" | Inspect X and report the answer; do not explain how to inspect it. |
| "why is this broken?" | Reproduce or trace first, then give root cause; do not lead with theories. |
| "review this PR" | Post GitHub review comments first, then summarize in Slack if useful. |
| "fix this" | Edit, verify, and report what changed. |
| "look into this bug" | Gather observability, classify read-only vs write-path, and route the bug pipeline. |
| structured customer/contact details with no explicit instruction | Ask one clarifying question unless an org overlay defines a safe default workflow for that channel. |

### 3. Add a parallelization/delegation default

Add this to orchestrator-capable prompts (`default`, `lead`, and any future coordinator):

```md
## Parallelization default

Before deep local exploration, split the task:

1. **Local critical path** — the next thing only you can do.
2. **Parallel agent work** — independent repo traces, observability fetches, reproduction, review, or summaries.
3. **Deferred verification** — checks that can run after implementation or after another agent returns.

Dispatch independent agents early when their result can reduce context load or wall-clock time. Do not wait for one agent before starting another unless the first result changes the second agent's task.
```

Pipeline override: explicit state machines beat the general parallelization default. In the bug pipeline, preserve the existing order: observability first, then reproducer for read-only bugs, then thinker. Do **not** run thinker in parallel with reproduction; a mismatch or not-reproduced result would poison the scope.

Use agents for:

- frontend vs backend tracing
- repo A vs repo B investigation
- observability fetches
- reproduction and code tracing only when no pipeline gate requires one to precede the other
- review or verification while implementation continues
- large-thread or large-file summarization

The dispatch prompt must be bounded: name the exact question, relevant paths, expected artifact, and when to stop.

### 4. Split common preambles by purpose

Today, common preambles can become large because every agent may receive building philosophy, runtime details, merge rules, and bug-pipeline structure.

Use narrower common files:

| File | Inject into | Purpose |
|---|---|---|
| `common/core.md` | all agents | short universal rules: action classifier, workspace safety, read repo rules |
| `common/building-philosophy.md` | build/frontend/thinker | verification and implementation rules |
| `common/merge-workflow.md` | lead/thinker only when merge/PR work is possible | branch, PR, merge invariants |
| `common/runtime-environment.md` | lead/thinker/reproducer | long environment notes, credentials paths, dev URLs |
| `common/orchestrator-dispatch.md` | lead/default | persistent-agent dispatch rules |

The always-on `core` preamble should stay very small.

V1 keeps `default` deliberately light: `core,orchestrator-dispatch`. Broad Slack asks that turn into repo work, PR work, or bug-pipeline work should route or act from the explicit task context instead of always carrying merge/runtime reference files.

Selection mechanism — required, not optional:

Before this overhaul, `AgentRouter.composeSystemPrompt()` loaded every `*.md` in the selected `common/` directory. Splitting files without changing the loader would not have reduced context. The overhaul replaces glob-all common loading with an explicit common profile:

```yaml
---
name: build
common: core,building-philosophy
---
```

Rules:

1. Load each selected file from target repo common first; if that file is absent, load the same file from Junior fallback common. Org overlay common remains additive.
2. Load `core.md` first when it exists, even if the agent's `common:` profile omits or misorders it.
3. Then load files named by the agent's `common:` profile, in declared order, de-duplicating `core`.
4. Apply the same selected filenames to org overlay common files when the overlay is configured; do not append every overlay `common/*.md` by default.
5. Top-level default runs resolve `default.md`; unknown unresolved agents fall back to `core` only rather than all common files.
6. Future prompt lint should fail if a public common file is not referenced by any profile and is not explicitly marked reference-only.

### 5. Reduce thread-history injection

`buildPromptPreamble()` currently supports full thread history up to 100 Slack messages. That is expensive and often unnecessary.

Change the policy to:

- default: last 10-20 relevant messages
- include attached image notes and current-message files
- use a rolling thread summary for long-lived threads
- allow specific agents to opt out with `context.threadHistory: false`

Suggested defaults:

| Agent | Thread history | Workspace | Agent state |
|---|---:|---:|---:|
| `lead` | summary + recent tail | yes | yes |
| `thinker` | no, read bug-folder files instead | yes | limited |
| `reproducer` | no, read bug-folder files instead | yes | limited |
| `review` | no unless bug pipeline | yes | no |
| `build` | recent tail only | yes | no |
| `frontend` | recent tail only | yes | no |
| `architect` | recent tail | maybe | no |
| `pm` | recent tail | no by default | no |

### 6. Rewrite agent prompts as workflows

Prompts should be procedural enough that a direct model can execute them without inferring hidden steps.

Example builder shape:

```md
## Build workflow

1. Load rules:
   - Read CLAUDE.md.
   - Read the relevant feature doc.
   - Read existing code before editing.

2. Classify the task:
   - bugfix
   - feature
   - refactor
   - docs only
   - investigation only

3. Execute only the requested scope.

4. Verify:
   - read modified files
   - run typecheck
   - run tests
   - repeat verification once

5. Final response:
   - changed files
   - verification run
   - blockers or follow-ups
```

This pattern should replace broad role prose in `build`, `frontend`, `architect`, `pm`, and especially `lead`.

Each workflow should end with a "Done means" checklist. This prevents the agent from stopping at analysis when the real task required an edit, dispatch, PR, or verification result.

Example:

```md
Done means:
- the requested change or investigation is complete
- the relevant verification ran, or the blocker is named
- any required worker was dispatched
- the final response reports outcome, not intentions
```

### 7. Convert the default Junior prompt into an orchestrator prompt

The default `@junior` path is where many implicit-action misses happen because it handles broad, casual asks outside the strict bug pipeline. Give it an explicit routing table instead of relying on personality and common preambles.

Implementation artifact: add `.claude/agents/default.md` and update manager/router resolution so the top-level default run resolves that file even when the user did not issue `!agent default`. Today, docs describe the default path as "common preamble only"; that should stop being true after this migration.

Suggested default prompt structure:

```md
## Default Junior routing

1. Classify the ask:
   - direct answer
   - code/doc action
   - review
   - bug pipeline
   - data/admin workflow
   - unclear or unsafe

2. If a worker owns the action, dispatch the worker with the user's facts.

3. If doing the work inline:
   - read current state first
   - keep context narrow
   - edit only requested scope
   - verify before final response

4. Ask exactly one clarifying question only when the next action would be unsafe or the worker lacks required starting data.
```

Default Junior should have a table of common triggers:

| Signal | Action |
|---|---|
| PR link + review ask | review on GitHub first |
| bug report in support channel | lead pipeline |
| bug report outside support channel | ask whether to run full pipeline or quick read |
| structured customer/contact details without an instruction | ask one clarifying question, unless an org overlay defines a safe channel default |
| frontend visual issue | inspect/reproduce visually; dispatch frontend/reproducer if full pipeline |
| prod-data concern | inspect codepath first; never mutate prod DB as a shortcut |

### 8. Convert the lead prompt into a state machine

`lead.md` is the highest-risk prompt because it coordinates the bug pipeline and has many exceptions. It should be rewritten around states and transitions:

```md
## Lead state machine

On new bug:
1. Read report and images.
2. Write report.md and state.json.
3. Register routed repo worktrees.
4. Run observability Tasks in parallel.
5. Classify read-only vs write-path.
6. Dispatch:
   - read-only -> !reproducer
   - write-path -> !thinker

On thinker Phase 1:
- Return NO_SLACK_MESSAGE unless there is a hard contradiction.
- Wait for human approval.

On human approval:
- Emit only: !thinker proceed

On review approved:
- read-only: wait for validation solved too.
- write-path: proceed to dev merge.

On blocker / mismatch / still-broken:
- Dispatch !thinker with the failing notes or escalate at round cap.
```

The lead should default to silence unless the current state matches an explicit allow-list.

### 9. Add compact final-response templates

Each agent should have a fixed output format.

Builder:

```md
Done:
- <1-3 bullets>

Verified:
- <commands run or not run with reason>

Notes:
- <blockers or none>
```

Reviewer:

```md
review: <approved | changes-requested | blocker> — <summary>
<N blockers, M warnings, K nits>
by review
```

Reproducer:

```md
<reproduction | validation>: <one-line summary> — <outcome>

<2-3 line detail>

<reproduction.md | validation.md>
by reproducer
```

Compact templates reduce rambling and make Slack threads easier to scan.

### 10. Add prompt linting

Add tests or a small lint script that fails when:

- public agent files contain `model: opus`
- the core common preamble exceeds a configured character budget
- an agent lacks an intent/action instruction
- bug-pipeline agents lack required output templates
- default thread history exceeds the configured budget

This prevents prompt drift back toward large-context, Opus-dependent behavior.

## Implementation Plan

PR #33 implements the infrastructure slice of this plan: Phases 1-3, the default-agent artifact from Phase 4, and selected tests from Phase 8. Phases 5-7 and the remaining prompt-lint work are backlog items, not shipped behavior in this PR.

| Phase | PR #33 status |
|---|---|
| 0. Branch and PR handling | In progress via PR #33 |
| 1. Core prompt architecture | Implemented |
| 2. OpenCode prompt source of truth | Implemented |
| 3. Provider-neutral agent metadata | Implemented |
| 4. Default Junior routing | Partially implemented: `default.md` exists and is explicit; deeper routing/body rewrites remain follow-up |
| 5. Lead state machine | Backlog |
| 6. Worker prompt rewrites | Backlog |
| 7. Context budget controls | Backlog |
| 8. Prompt linting and tests | Partially implemented |
| 9. Verification | Implemented for focused prompt/OpenCode suite; full suite remains blocked by unrelated dev-server fixture |

### Decision

Do the full prompt overhaul now from current `main` after PR #32. Supersede [PranavBakre/Junior#31](https://github.com/PranavBakre/Junior/pull/31) as a standalone PR unless it is explicitly rebased and converted into this overhaul.

[PranavBakre/Junior#31](https://github.com/PranavBakre/Junior/pull/31) contains useful discovery and should be used as source material, not merged independently:

- OpenCode should run through the built-in `build` agent, not custom generated agent names.
- `agent.build.prompt` can be overridden while preserving OpenCode's native tool/permission surface.
- Because Junior overrides the full provider prompt, the OpenCode baseline must include provider-level coding behavior, not only Junior persona text.

PR #32 contains the current applied prompt surface:

- static `.opencode/agents/*` files
- `opencode.json` instruction wiring
- OpenCode tool-use mapping and duplicate Slack-post suppression

The overhaul should consolidate these directions: keep PR #32's applied OpenCode agent-overlay work, close or absorb PR #31, and decide whether OpenCode's long-term prompt source is static `.opencode/agents/*`, generated `agent.build.prompt`, or a deliberately combined model.

### Phase 0 — Branch and PR Handling

- Create the overhaul branch from current `main` after PR #32.
- Close [PranavBakre/Junior#31](https://github.com/PranavBakre/Junior/pull/31) as superseded, or reuse its branch only if it is reset/reworked on top of current `main` and includes the full scope.
- Copy the useful PR findings into this doc and the final PR description.
- Treat PR #32's `.opencode/agents/*`, `opencode.json`, parser, and Slack-formatting changes as the starting implementation.
- Do not merge that PR independently.

Exit criteria:

- One active PR owns OpenCode prompt quality and model-neutral prompt adaptation.
- [PranavBakre/Junior#31](https://github.com/PranavBakre/Junior/pull/31) is either closed or clearly converted into the overhaul PR on top of PR #32.
- The overhaul PR description states how it relates to PR #32 and PR #31.

### Phase 1 — Core Prompt Architecture

Create a compact universal prompt layer and make it the first common preamble loaded for every agent:

- Add `common/core.md` with the action classifier, implicit-action table, and context-budget rule.
- Move universal workspace safety and "read current state before planning" rules into `common/core.md`.
- Keep `common/core.md` short enough to be always-on.
- Split large common material into targeted common files:
  - `common/building-philosophy.md`
  - `common/merge-workflow.md`
  - `common/runtime-environment.md`
  - `common/orchestrator-dispatch.md`
- Add `common:` frontmatter parsing to agent definitions, using comma-separated file stems such as `core,building-philosophy`.
- Update prompt composition so `core` is injected before agent-specific content and only profile-selected common files are loaded. Do not glob every `common/*.md` into every agent.
- Keep `opencode.json` free of prompt instructions so `agent.build.prompt` remains the single OpenCode prompt source of truth.
- Apply the same selected common profile to org overlay common files so private specifics remain targeted instead of universally appended.

Exit criteria:

- A composed prompt for `default`, `lead`, `thinker`, and `review` includes the action classifier.
- Generated OpenCode `agent.build.prompt` includes `common/core.md` in `<junior-core>`.
- `common/core.md` is small, universal, and provider-neutral.
- Long runtime/reference material is not injected into agents that do not need it.
- A test proves adding an unreferenced common file does not automatically inject it into `pm` or `review` unless their common profile requests it.

### Phase 2 — OpenCode Prompt Source Of Truth

Decide and implement the OpenCode prompt source of truth.

Current PR #32 uses static `.opencode/agents/*` plus `opencode.json` instructions, but the runner also generates `OPENCODE_CONFIG_CONTENT` on every spawn. That generated config now defines `agent.build.prompt` from a provider baseline plus Junior's dynamic `session.systemPrompt`. The overhaul must not leave static OpenCode agents and generated OpenCode agents competing silently.

Audit result: generated `OPENCODE_CONFIG_CONTENT` is the runtime source of truth, and generated `agent.build.prompt` preserves `native: true` while custom generated agent names resolve as `native: false`.

Recommended v1:

- Treat generated `OPENCODE_CONFIG_CONTENT` as the runtime source of truth, because Junior needs dynamic per-session prompts, MCP config, and permissions there.
- Switch runtime OpenCode runs to `--agent build` with generated `agent.build.prompt`.
- Keep Junior identity/routing in the generated prompt and environment, not in the OpenCode provider agent name.
- Preserve the main-agent parallelization path. The generated `agent.build.prompt` must include the parallelization/delegation default and must keep Task/sub-agent tool access available where the agent role needs it.
- Use `.opencode/agents/*` as source/authored prompt files only if the generator reads or mirrors them; otherwise delete or clearly mark them as local-dev/manual OpenCode agents so they are not mistaken for Junior runtime prompts.
- Build the generated prompt from a complete provider baseline plus `common/core.md` plus the dynamic Junior agent prompt.

Generated prompt shape:

```text
<opencode-provider-baseline>
compact provider/tool/workspace/safety behavior
</opencode-provider-baseline>

<junior-core>
common/core.md content
</junior-core>

<junior-active-agent>
default | lead | build | review | ...
</junior-active-agent>

<junior-agent-prompt>
dynamic composed Junior agent prompt
</junior-agent-prompt>
```

- Tests must prove per-Junior-agent identity/routing still works when every OpenCode run uses provider agent `build`.
- Preserve that PR's test coverage shape:
  - provider baseline exists when no Junior prompt is present
  - dynamic Junior prompt is appended with delimiters
  - `OPENCODE_CONFIG_CONTENT` contains the actual runtime agent prompt

Exit criteria:

- There is one documented OpenCode prompt strategy.
- OpenCode runs receive complete provider-level behavior plus Junior instructions.
- Static `.opencode/agents/*` and generated prompts either share a source or have clearly separate roles.
- Tests prove OpenCode receives more than persona text.
- Tests prove `--agent build` preserves required tool/MCP behavior and does not break Junior's per-agent Slack identity/routing.
- Tests or smoke prompts prove the main agent can still fan out independent work instead of carrying all repo/research context itself.

### Phase 3 — Provider-Neutral Agent Metadata

- Remove `model: opus` from public fallback agents.
- Either omit model fields or introduce provider-neutral `modelTier` only if runtime support is implemented in the same PR.
- If runtime support is not implemented now, prefer deleting concrete model frontmatter over adding unused metadata.
- Keep private/product-repo agent rewrites out of scope unless they block prompt composition.

Exit criteria:

- `rg "^model: opus" .claude/agents agents-org support` returns no public fallback agent hits.
- Agent loading tests pass.
- No prompt assumes Claude-only model names.

### Phase 4 — Default Junior Routing

Create or rewrite the default Junior prompt so broad Slack asks do not depend on hidden inference:

- Add action categories:
  - direct answer
  - code/doc action
  - PR review
  - bug pipeline
  - data/admin workflow
  - unclear or unsafe
- Add trigger table for implicit actions:
  - PR review -> GitHub comments first
  - structured customer/contact details without an instruction -> clarify unless overlay defines a safe default
  - "check X" -> inspect X
  - bug report -> pipeline or quick-read question depending channel
  - prod-data concern -> inspect codepath first, no shortcut mutation
- Add delegation default: split local critical path vs parallel agent work before deep exploration.
- Add "Done means" checklist for default Junior.
- Add `.claude/agents/default.md` and wire the default top-level run to resolve it.
- Apply the same routing behavior to the generated OpenCode runtime prompt.

Exit criteria:

- `default` has explicit routing triggers.
- The generated OpenCode `agent.build.prompt` has explicit action/routing behavior.
- The default prompt is an explicit agent artifact, not an accidental common-preamble-only path.
- Broad requests can be answered by table/state, not personality prose.
- Default Junior knows when to dispatch and when to ask one clarifying question.

### Backlog Phase 5 — Lead State Machine

Rewrite `lead.md` around explicit states and transitions:

- New bug intake.
- Observability fanout.
- Read-only vs write-path classification.
- Reproducer dispatch.
- Thinker Phase 1 received.
- Human approval / reconsideration.
- Thinker Phase 2 / PR opened.
- Review approved / changes requested / blocker.
- Validation solved / partially solved / still broken.
- Dev merge done.
- Round cap escalation.

Keep the existing pipeline gates. The rewrite should reduce ambiguity, not loosen the audit trail.

Exit criteria:

- `lead.md` contains a clear state-machine section.
- The generated OpenCode runtime prompt includes the same lead state-machine contract when the active Junior agent is `lead`.
- Lead default action is silence unless the current state allows a post or directive.
- State transitions cover human gate and write-path skip rules.
- The parallel observability instruction remains explicit.

### Backlog Phase 6 — Worker Prompt Rewrites

Rewrite public worker prompts into checklist-first workflows:

- `build.md`
- `frontend.md`
- `review.md`
- `architect.md`
- `pm.md`
- targeted cleanup of `thinker.md` and `reproducer.md` only where long prose hides required state transitions
- mirrored cleanup in the generated OpenCode prompt source so Claude and OpenCode agent behavior stays equivalent

Each prompt should include:

- workflow steps
- scope boundaries
- verification checklist
- compact final response template
- "Done means" checklist

Exit criteria:

- Worker prompts are procedural and compact.
- Claude agent prompts and generated OpenCode prompts have aligned contracts, even if syntax/tool names differ.
- If `.opencode/agents/*` remain in the repo, they are either generated from the same source, used as source files by the generator, or clearly marked manual-dev only.
- Review/reproducer/thinker output templates are preserved or tightened.
- No worker prompt relies on "be smart" prose where a state transition or checklist is needed.

### Backlog Phase 7 — Context Budget Controls

Apply context reductions after the prompt shape is clear:

- Set stricter `context.*` frontmatter per agent.
- Reduce raw thread-history default from 100 messages to a recent tail.
- Add rolling thread summary only if needed; do not build a full summarization subsystem before prompt rewrites land.
- Prefer bug-folder files over raw Slack history for bug-pipeline workers.
- Preserve bug-pipeline ordering while reducing context: observability output files and reproduction traces feed thinker; thinker should not be dispatched before the reproducer outcome for read-only bugs.

Suggested first pass:

- `thinker`: `context.threadHistory: false`, reads bug-folder files.
- `reproducer`: `context.threadHistory: false`, reads bug-folder files and images referenced in report.
- `review`: `context.agentState: false`; thread history only when bug-pipeline review needs it.
- `build`/`frontend`: recent tail only.
- `pm`: no workspace by default unless task needs repo context.

Exit criteria:

- Long bug threads do not inject full 100-message history into every worker.
- Agent prompts still include enough context to act without Slack search.
- Existing first-turn/resume behavior remains safe.

### Backlog Phase 8 — Prompt Linting and Tests

Add a small lint/test surface for prompt invariants:

- no public fallback agent contains `model: opus`
- `common/core.md` exists and stays under a configured character budget
- composed prompts for `default`, `lead`, `thinker`, and `review` include core/action classifier
- OpenCode generated `agent.build.prompt` includes provider baseline and core classifier
- tests assert whether static `.opencode/agents/*` are source prompts or manual-dev prompts
- bug-pipeline agents contain required output templates
- raw thread-history limit is below the new budget

Exit criteria:

- Prompt lint runs in `bun test` or an explicit `bun run lint:prompts`.
- Snapshot or targeted tests cover prompt composition.
- Deliberately adding `model: opus` or removing the core classifier fails locally.

### Phase 9 — Verification

Run two clean passes:

1. Read every modified prompt/code file.
2. Run typecheck.
3. Run relevant prompt/OpenCode tests.
4. Run full test suite if practical.
5. Re-read final composed prompt snapshots or test fixtures.
6. Repeat typecheck/tests after any fix.

Manual smoke tests:

- Compose prompt for `default`, `lead`, `thinker`, `review`.
- Start an OpenCode-backed dry run and inspect generated `OPENCODE_CONFIG_CONTENT`.
- Confirm OpenCode uses provider agent `build` and generated `agent.build.prompt`.
- Send representative dry prompts:
  - "can you check this PR?"
  - "why is this broken?"
  - structured customer/contact details with no explicit instruction
  - bug report with write-path risk

Exit criteria:

- Two consecutive clean verification passes.
- The final PR description names [PranavBakre/Junior#31](https://github.com/PranavBakre/Junior/pull/31) as superseded and lists the useful findings carried forward.

## Cut List

- Do not build a full prompt optimizer yet.
- Do not add per-model prompt variants until the provider-neutral baseline is working.
- Do not rewrite product-repo private agents in this pass; start with Junior's public fallback agents and common preambles.
- Do not remove bug-pipeline auditability. The goal is smaller prompts, not fewer required gates.
