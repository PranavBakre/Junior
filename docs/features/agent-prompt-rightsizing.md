# Agent Prompt Rightsizing (Claude 5 context engineering)

**Status:** proposal
**Date:** 2026-07-25
**Trigger:** [The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
**Context:** the fleet is switching to the Claude runner on Opus 5, so the
article's guidance applies to every agent uniformly.

## Why this doc exists

Anthropic cut >80% of Claude Code's system prompt for Claude 5 models. The stated
reasoning: newer models make nuanced calls well, so exhaustive rules crowd out
context and create contradictions the model must spend reasoning to resolve.

Junior's agent prompts grew the other direction. This doc measures the current
state, decides which of the article's rules apply to an unattended fleet, and
lists the concrete edits.

**Bottom line:** apply the article aggressively to redundancy and tool-manual
prose; apply it cautiously to guardrails. Target ~45–55% reduction on the heavy
agents — not 80%, because a meaningful share of what looks like bloat is
incident-derived guardrail on agents that merge PRs unsupervised.

## Measured baseline

Assembled preamble + agent body, before any user message or thread history.
Composition follows `src/agents/router.ts` (`common:` profile → public files →
org overlay appended additively).

| Agent | Common profile (effective) | Assembled |
|---|---|---|
| `default` in a support channel | core, orchestrator-dispatch, pipeline-start, pipeline-outcome, product-pipeline, merge-workflow, runtime-environment, bug-pipeline (+3 org overlays) | **~17.8k tokens** |
| `review` | core, merge-workflow, runtime-environment, pipeline-outcome (+2 org overlays, + org `review.md`) | ~13.9k tokens |
| `reproducer` | core, runtime-environment, pipeline-outcome (+1 org overlay) | ~7.6k tokens |
| `build` | core, building-philosophy, pipeline-outcome | ~4.0k tokens |

Corpus: 3,396 lines across 18 agent definitions and 12 common files.

### Measured redundancy

Occurrence counts across `CLAUDE.md`, `.claude/agents/`, and `agents-org/`:

| Rule | Files stating it |
|---|---|
| `memory_recall` cadence | 20 (on top of `core.md` owning it) |
| "Done means" epilogue | 13 |
| "Two consecutive clean passes" | 5 |
| "No `as any`" | 5 |
| "Report outcome, not intentions" | 4 |
| Swappability / sync-before-reading / trust-the-build / categorize-before-bulk | 2 each (`CLAUDE.md` **and** `building-philosophy.md`, near-verbatim) |

## What applies, what doesn't

### Applies directly

**Tool instructions belong in tool descriptions, not the system prompt.**
`common/pipeline-outcome.md` is 70 lines of manual for `pipeline_report_outcome`
and `agent_dispatch`, including hand-written JSON payload shapes. It loads for
every agent on every turn. This is the article's canonical anti-pattern, and the
payload shapes are worse than redundant — they're prose the model must recall
correctly when the tool's own input schema could enforce them.

**Stop repeating instructions across layers.** See the table above. The article
is explicit that redundancy across system prompt and tool descriptions forces
unnecessary deliberation.

**Design expressive interfaces instead of writing examples.** The
`action: "complete" | "continue_self" | "wait" | "escalate"` enum already hints
at correct usage the way the article's Todo-tool `status` field does. The prose
around it is mostly restating what the enum says.

**Progressive disclosure.** `bug-pipeline.md` (203 lines) plus the bug-folder
layout and `state.json` shape in `runtime-environment.md` are only relevant once
a bug thread is live. Junior already has agent-granularity progressive disclosure
via `common:` profiles; the gap is intra-turn loading.

**Remove judgment-substituting rules.** `core.md`'s "Common implicit actions"
table ("can you check X" → inspect X) and `default.md`'s routing table encode
inferences a Claude 5 model makes natively.

### Resolved by the runner switch

An earlier draft of this doc gated the judgment-based cuts on model, because the
default runner was `opencode` and 11 of 18 agents pinned `model: gpt-5.6-sol`. **The
fleet is moving to the Claude runner on Opus 5, which removes that gate.**

The pinned frontmatter does not need editing. Verified chain:

`model:` frontmatter → `AgentDefinition.model` (`src/agents/loader.ts:114`) →
`runSession.model` (`src/session/manager.ts:1754-1755`) → `sessionModel` →
`resolveClaudeModel` precedence rule 3 (`src/claude/model.ts:20-22, 50-53`),
which maps `gpt-5.6-sol` → `opus`. The mapping is documented in that file as a
deliberate equivalent-capability-tier decision taken at the runner switch, and
`src/claude/model.test.ts` covers it directly (`maps gpt-5.6-sol → opus`; 17/17
passing as of this doc).

So every `model: gpt-5.6-sol` agent resolves to Opus 5 without touching 11 files,
and the whole fleet is Claude 5 generation.

Two follow-ons worth noting, neither blocking:

- `resolveClaudeModel` rule 3 falls back to `configDefaultModel` for *unmapped*
  GPT ids. No agent currently pins one, but a future `gpt-*` pin would silently
  land on the default tier rather than erroring.
- `src/session/manager.ts:1286` hard-codes `s.model = "haiku"` on one path.
  Worth confirming that path is still intended once the fleet is Claude-only.

Consequence for this plan: the article's guidance applies uniformly. Phase 3 no
longer needs per-agent model gating — it stays behind measurement only because
those cuts are behavioral, not because some agents run a different model.

### Still does not apply cleanly

**These agents run unattended.** Claude Code's cut was validated in an
interactive loop where a human sees drift within seconds. Junior's agents open
PRs, merge, and touch production-adjacent paths inside a Slack thread with no
turn-level supervision. Most of `merge-workflow.md` is scar tissue from real
incidents (squash merge, wrong base branch, `git add -A`, merging without the
admin token). Under the article's own framing that content **is** the
"non-obvious gotchas" tokens should be spent on. It stays.

## Contradictions found

The article flags conflicting guidance as a direct cost — the model burns
reasoning resolving it. One real instance:

- `common/building-philosophy.md`: "**Checkpoint = commit.** Every working state
  gets committed with a descriptive message."
- `.claude/agents/build.md`: checkpoint commits happen "when the assignment
  authorizes mutation."

Unconditional vs. conditional, both loaded into every builder turn. A builder
reading both has to guess whether an unauthorized-mutation assignment still
requires committing working state.

### The fix

Split on the axis that actually differs: `building-philosophy.md` owns the
*shape* of a checkpoint commit (it is shared across all builders and carries no
authority claim); `build.md` and `frontend.md` own *when* one is authorized
(assignment-scoped). Neither file then states the other's half.

**`common/building-philosophy.md`** — replace:

> **Checkpoint = commit.** Every working state gets committed with a descriptive
> message. Don't accumulate multiple features in uncommitted state.

with:

> **Checkpoint commits are small, explicit, and descriptive.** When your
> assignment authorizes mutation, commit each working state rather than
> accumulating several changes uncommitted — staging explicit paths only, never
> `git add -A`. Your agent definition says whether mutation is authorized.

**`.claude/agents/build.md`** — the existing step 5 already carries the
authority condition and the explicit-paths rule. Drop the duplicated
explicit-paths sentence now that `building-philosophy.md` states it, leaving
step 5 to own only the authorization boundary and the base branch:

> 5. **Checkpoint commit.** Only when the assignment authorizes mutation.
>    Untracked local files in the working tree are sacred; don't sweep them in.
>    Branch from the repo's primary base (usually `main`) when creating work.

Same edit in `frontend.md` if it carries the parallel step.

Net effect: one statement of the shape, one statement of the authority, no
overlap. The `git add -A` prohibition also stops being stated in three places
(`building-philosophy.md`, `build.md`, `merge-workflow.md` guardrail 5) — keep
it in `building-philosophy.md` for builders and `merge-workflow.md` for
merge-path agents, drop it from `build.md`.

This edit belongs in **Phase 2**; it is behavior-neutral and needs no
measurement.

## Proposed changes

Ordered by value-to-risk. Phases 1–2 are behavior-neutral; phase 3 needs
measurement.

### Phase 1 — Move tool manuals into tool definitions (code change)

| Change | Where | Saves |
|---|---|---|
| Move the four canonical payload shapes out of prose into the `pipeline_report_outcome` input schema; make the schema enforce `evidenceRefs`/`artifactRefs`/`blockers`/`checks` presence rather than instructing it | `src/pipelines/` MCP tool defs ← `common/pipeline-outcome.md` | ~1.5k tok × every agent |
| Move `idempotency_key` retry semantics and the state-version-conflict recovery into the tool description | same | ~400 tok |
| Delete the "Available MCP tools" inventory; the tool block already carries it. Keep only the MongoDB read-only policy, and prefer moving that into the mongodb tool wrapper description | `common/runtime-environment.md` | ~600 tok |
| Move the `delegate` vs `handoff` vs `continue_self` distinction into `agent_dispatch`'s `mode` enum description | `agent_dispatch` def | ~300 tok |

Residual `pipeline-outcome.md` should be the policy that isn't expressible in a
schema: one transport per delegation, never announce advancement before the
receipt is accepted, escalation visibility differing between `default` and typed
runs.

### Phase 2 — Deduplicate to one authoritative home (prompt edits)

| Change | Files touched |
|---|---|
| `CLAUDE.md` Engineering Principles → keep the junior-repo-specific ones, delete the four that `building-philosophy.md` states verbatim, replace with a pointer | `CLAUDE.md` |
| Delete per-agent memory-recall paragraphs; `core.md` owns the cadence | 7 public + 11 org agents |
| Delete per-agent "Done means" epilogues; keep the one in `core.md`. Agent-specific acceptance criteria (e.g. review's "inline comments posted for every blocker") stay, as one line, in the body | 13 files |
| Collapse "two clean passes" / "no `as any`" / "report outcome not intentions" to `building-philosophy.md` and `core.md` only | 5 files |
| Delete `build.md`'s "Anti-Patterns" section — every entry is the negation of a rule already stated positively above it | `build.md`, `frontend.md` |
| Collapse the ownership matrix (builder / orchestrator / review / human) into `core.md`; agents keep at most a one-line pointer | `default.md`, `build.md`, `review.md` |
| Resolve the checkpoint-commit contradiction as described above | `building-philosophy.md`, `build.md` |

Estimated: ~3–4k tokens off `default`, ~2k off `review`, ~800 off `build`.

### Phase 3 — Progressive disclosure and judgment (measured)

| Change | Notes |
|---|---|
| `bug-pipeline.md` (203 lines) → loaded when a bug run is actually live, not on every support-channel turn | Needs a loader hook; `common:` profiles are per-agent, this is per-turn |
| Bug folder layout + `state.json` shape → move out of `runtime-environment.md` into the same on-demand load | ~700 tok |
| `merge-workflow.md` → loaded when a PR/merge tool is in play | **Do not delete.** Deferring is safe; removing is not |
| Delete `core.md`'s "Common implicit actions" table | Applies fleet-wide post-switch |
| Collapse `default.md`'s routing table to prose stating the three modes | Applies fleet-wide post-switch |
| Rewrite `orchestrator-dispatch.md` model routing | **Now stale.** It routes to "opus / sonnet / haiku / composer / deepseek-class" tiers that assume the OpenCode fleet. Rewrite against what the Claude runner actually offers, and re-check the "never review a builder's output with the same model that built it" rule — on a single-provider Claude fleet that has to mean a different *agent*, since a different provider is no longer available |

No per-agent model gating: after the switch every agent resolves to Opus 5.
These stay in Phase 3 because the cuts are behavioral, not because the fleet is
mixed — land them with the before/after measurement in the verification plan.

## Verification plan

Prompt edits have no typecheck. The checks that matter:

1. `bun test src/agents/` — `lint.test.ts` and `verification.test.ts` already
   validate definitions and policy; confirm they cover deleted-section cases.
2. Re-measure assembled sizes per agent before/after (the composition in
   `router.ts` is the source of truth, not raw file sizes — org overlays append).
3. Behavioral regression on the guardrails that got moved rather than deleted:
   a merge-workflow dispatch must still refuse a squash merge and still demand
   the admin token once `merge-workflow.md` is deferred rather than preloaded.
   This is the one place a wrong cut ships damage instead of noise.
4. Run `/doctor` in Claude Code against `CLAUDE.md` and the agent files for an
   independent rightsizing read.

## Explicitly out of scope

- Cutting `merge-workflow.md`'s substance.
- Cutting the reproducer's honesty posture (`not-reproduced` is a legitimate
  outcome). That's a taste calibration against a strong completion bias, not a
  rule the model would infer.
- Cutting worktree/workspace boundary rules — those encode a permission model.
- Editing the `model: gpt-5.6-sol` frontmatter pins as part of the runner switch.
  `resolveClaudeModel` maps them to `opus` already; rewriting 11 files to say
  the same thing is churn. Revisit only if an agent needs a tier *other* than
  the default.

## Open question

Ownership boundaries currently live in prose ("review never edits product
code"). `permissions.intent: read-only` in the frontmatter already expresses
this structurally. The article's "design expressive interfaces" rule suggests
the prose should go and the permission model should be the enforcement — worth
checking whether `permissions.intent` is actually enforced at the tool layer or
is advisory, before deleting the prose that backstops it.
