# Memory Ingestion Rule Learning

## Problem

Associative memory only works if messy Slack conversations become clean, consistent memory records: events, tags, entities, edges, lessons, and routing facts. LLM-only extraction will drift. Hand-written rules will miss patterns. The system needs a path to improve ingestion rules from real history without putting experimental rule learners in the hot path.

**Who has this problem:** The memory ingestion pipeline and any feature consuming memory recall, including agent selection.
**What happens today:** Tags/events would be produced by heuristics or LLM calls, with no formal loop for learning better symbolic rules from corrections.
**Painful part:** If tags and event types are inconsistent, recall and agent selection both degrade. The same phrase can be tagged differently over time.
**"Finally" moment:** Junior notices repeated corrected classifications, proposes a readable rule like `tag(Event, frontend) :- mentions(Event, css).`, and future ingestion becomes cheaper and more consistent after review.

## Position

> **Superseded by [Primary Approach: Dreaming Writes the Rules](#primary-approach-dreaming-writes-the-rules) below.** The ILP-as-learner framing in this section is retained as a fallback reference only.

Metagol and Popper should not be part of the live routing or recall path initially. They fit better as **offline rule learners for the memory ingestion layer**.

Use them to suggest rules for:

- tag generation;
- event type classification;
- memory storage/promotion decisions;
- relationship/edge creation;
- routing-memory extraction.

The runtime path should remain simple:

```text
raw Slack messages
  ↓
cheap deterministic capture and heuristics
  ↓
store raw source records, events, and simple metadata with provenance
  ↓
log corrections and outcomes
```

Then offline:

```text
classification history + corrections + consolidation decisions
  ↓
Popper/Metagol learns candidate symbolic rules
  ↓
human or high-confidence gate reviews
  ↓
accepted rules become normal ingestion rules
```

## Primary Approach: Dreaming Writes the Rules

**Design-review update: the V2 "dreaming" consolidation engine should author candidate ingestion rules directly. Popper/Metagol are demoted to a research spike, not the planned path.** The ILP sections that follow are retained as the *only-if-needed* fallback.

The realization: the V2 consolidation/"dreaming" pass is *already* an offline LLM run over recent source records and corrections. Rather than exporting labeled examples to a separate ILP learner, let dreaming emit candidate rules into the bounded predicate DSL as one more promotion type, alongside `promote_lesson` / `promote_fact`.

This collapses the old "ILP V3" into V2 and removes its three biggest costs:

- **No labeled-data gate.** The dreaming LLM proposes a rule from observed patterns + corrections already in context. It does not need a curated positive/negative example set accumulated over months before it can produce anything.
- **No second runtime.** No Popper/Metagol, no Python/SWI toolchain, no compile-from-learned-Prolog step. The rule author lives in the offline job that already runs.
- **The cost justification flips positive.** You pay one dream-time LLM call to mint a rule that then runs deterministically and replaces N future per-event extraction calls. ILP never had a clean story for that; this does.

**Crucially, the safety pipeline does not change — only the *author* of the candidate rule changes** (the dreaming LLM instead of Popper). Every candidate still: starts as `draft`, carries the examples it covers and the examples it would misfire on, is scored for precision/recall on held-out history, passes human review or a strict auto-threshold, and compiles into the TypeScript rule set or a constrained symbolic evaluator. See [Runtime Safety](#runtime-safety) — it applies unchanged.

Two risks survive and must be guarded:

1. **Confabulation instead of overfitting.** ILP overfits to label noise; an LLM *invents* a plausible-but-wrong rule from a coincidence (e.g. sees "dashboard" + "500" twice and writes `tag(Event, backend) :- mentions(Event, dashboard)` when the real cause was a frontend bug). Same blast radius, different mechanism — and the same `draft → held-out eval → gate` pipeline contains it.
2. **Model monoculture / grading its own homework.** If the *same* model both extracts events and writes the rules that classify events, its biases self-reinforce and it cannot catch its own systematic errors. ILP's hidden value was being a *different kind* of learner. Mitigation: the held-out evaluation must score against **human-confirmed corrections** as ground truth, never against LLM judgments. Keep one independent signal in the loop.

Constrain the dreaming output to the bounded predicate DSL (`mentions`, `tag`, `event_type`, `edge`, …) — never arbitrary executable TypeScript or free-form Prolog on the hot path.

**Popper/Metagol remain documented below as a fallback only.** Resurrect ILP if, and only if, a measured need for recursive or meta-rule synthesis appears that the dreaming LLM cannot produce reliably — which at Junior's scale is unlikely.

## Recommended V1

Do not build Popper, Metagol, or any other ILP loop in v1. Build the data needed to make that work later.

1. Log every ingestion classification with input text, extracted mentions, assigned tags, event types, edges, extractor name, confidence, and source id.
2. Log every correction as a first-class record, including who corrected it and which field changed.
3. Keep the live classifier simple: deterministic rules first, LLM extraction only for fields deterministic rules cannot safely infer.
4. Require provenance for every derived tag, entity, edge, lesson, and routing fact.
5. Add a local evaluation script that replays stored examples against the current ingestion rules and reports precision/recall-style counts.
6. Store draft learned rules only as text/artifacts, not as executable production behavior.
7. Do not call an LLM merely to decide whether to store raw memory; raw source capture should be cheap and broad.

V1 success means Junior can answer "why did this memory get this tag/type/edge?" and "what examples would a future learner train on?" It does not need to learn rules yet.

## Recommended V2

After V1 has enough accepted and rejected classifications:

1. Have the dreaming/consolidation engine emit candidate rules into the bounded predicate DSL as a promotion type (see [Primary Approach](#primary-approach-dreaming-writes-the-rules)). This is the default path.
2. Treat Popper/Metagol as a fallback research spike, only if recursive/meta-rule synthesis is measurably needed and the dreaming LLM can't produce it reliably.
3. Generate candidate rules offline with explicit positive examples, negative examples, and held-out metrics.
4. Review learned rules manually or pass them through a strict promotion gate before they affect live ingestion.
5. Compile accepted rules into TypeScript or a constrained symbolic evaluator with bounded predicates, not arbitrary hot-path Prolog.
6. Keep recording provenance every time an accepted learned rule fires.

V2 should reduce LLM extraction drift and cost. It should not replace source-backed memory, human review of risky rule changes, or deterministic runtime behavior.

## Why This Fits Memory Ingestion

Tagging and event routing are bounded symbolic classification problems. They are a better match for inductive logic programming than open-ended recall.

Examples:

```prolog
tag(Event, frontend) :-
  mentions(Event, css).

tag(Event, backend) :-
  mentions(Event, api),
  mentions(Event, error_500).

event_type(Event, routing_correction) :-
  mentions(Event, wrong_agent),
  mentions(Event, should_use_agent).

event_type(Event, blocker) :-
  mentions(Event, blocked),
  mentions(Event, missing_info).

promote(Event) :-
  event_type(Event, correction),
  repeated_pattern(Event).
```

These rules are compact, readable, and useful once learned. They can reduce LLM calls and make future memory records more consistent.

## What Metagol and Popper Do

Metagol and Popper are Inductive Logic Programming / Meta-Interpretive Learning tools. Given:

- background facts;
- positive examples;
- negative examples;
- allowed predicates/rule shapes;

they infer candidate Prolog-style rules.

Conceptually:

```text
examples + background predicates + search bias
  ↓
learned symbolic rule
```

## Popper vs Metagol

### Popper

Prefer Popper for this feature.

Good fit for:

- classification-style rules;
- positive/negative examples;
- readable Prolog-like outputs;
- constraints that prune bad hypotheses.

Example target:

```prolog
tag(Event, frontend) :- mentions(Event, css).
```

### Metagol

Metagol is more useful when recursive/meta-rule-heavy learning is needed.

It is powerful, but less practical for the first ingestion rule learner because this problem is mostly classification and relationship induction, not recursive program synthesis.

## Candidate Rule Domains

### Tag Generation

Input examples:

```text
"dashboard CSS broken"       -> tag: frontend, dashboard, styling
"dashboard API returns 500"  -> tag: backend, dashboard, api
"PR #123 review this"        -> tag: review, pr
```

Learned rules might become:

```prolog
tag(Event, frontend) :- mentions(Event, css).
tag(Event, backend) :- mentions(Event, api).
tag(Event, review) :- mentions(Event, pr_number).
```

### Event Type Classification

Useful event types:

```text
decision
correction
blocker
lesson_candidate
status_update
routing_correction
user_preference
repo_alias
```

Example learned rules:

```prolog
event_type(Event, routing_correction) :-
  mentions(Event, agent_name),
  mentions(Event, correction_language).

event_type(Event, user_preference) :-
  mentions(Event, preference_language),
  mentions(Event, first_person_user).
```

### Edge Creation

Rules can propose relationships between memories:

```prolog
edge(Event, Lesson, lesson_from) :-
  event_type(Event, failure),
  generated_from(Lesson, Event).

edge(NewFact, OldFact, supersedes) :-
  same_entity(NewFact, OldFact),
  contradicts(NewFact, OldFact),
  newer(NewFact, OldFact).
```

### Storage and Promotion

Rules can help the consolidation/"dreaming" engine decide whether something stays hot, archives cold, becomes a long-term lesson, or becomes durable routing/procedural memory:

```prolog
promote(Event) :-
  event_type(Event, blocker),
  importance(Event, high).

promote(Event) :-
  event_type(Event, correction),
  repeated_pattern(Event).

archive(Event) :-
  low_importance(Event),
  not(unresolved(Event)),
  not(reused(Event)).
```

### Agent-Selection Memory Extraction

Some ingestion rules should create routing-specific memory facts:

```prolog
routing_fact(Event, repo_alias) :-
  mentions(Event, dashboard),
  mentions(Event, gx_admin_client).

routing_fact(Event, routing_correction) :-
  selected_agent(Event, OldAgent),
  corrected_agent(Event, NewAgent),
  OldAgent \= NewAgent.
```

These facts later feed [Memory-Informed Agent Selection](memory-informed-agent-selection.md).

## Data Needed to Learn Rules

The ingestion pipeline should log enough information to create examples later:

```ts
type IngestionClassification = {
  eventId: string;
  inputText: string;
  extractedMentions: string[];
  assignedTags: string[];
  assignedEventTypes: string[];
  createdEdges: Array<{ src: string; dst: string; type: string }>;
  extractor: "capture" | "heuristic" | "llm" | "manual" | "learned_rule";
  confidence: number;
  createdAt: number;
};

type IngestionCorrection = {
  eventId: string;
  field:
    | "tag"
    | "event_type"
    | "edge"
    | "promotion"
    | "archive"
    | "routing_fact"
    | "validity";
  incorrectValue?: string;
  correctValue?: string;
  correctedBy: "user" | "agent" | "reviewer";
  createdAt: number;
};

type ConsolidationDecision = {
  eventId: string;
  action:
    | "promote_lesson"
    | "promote_fact"
    | "promote_routing_memory"
    | "archive"
    | "mark_stale";
  reason: string;
  sourceIds: string[];
  extractor: "heuristic" | "llm" | "manual" | "learned_rule";
  createdAt: number;
};
```

Positive examples come from accepted classifications and accepted consolidation decisions. Negative examples come from corrected/rejected classifications, rejected promotions, and corrected archive/staleness decisions.

## Runtime Safety

Learned rules should not be executed immediately without guardrails.

Required controls:

1. generated rules start as `draft`;
2. rules include examples they cover and examples they reject;
3. rules include precision/recall estimates on held-out history;
4. rules are human-reviewed or pass a strict auto-promotion threshold;
5. accepted rules are compiled into the normal TypeScript ingestion rule set or a constrained symbolic module;
6. every learned-rule application records provenance.

Do not let an LLM or ILP tool write arbitrary hot-path code or arbitrary Prolog that executes directly in production.

## Recommended Sequence

1. Build deterministic capture and simple ingestion first.
2. Store classifications with provenance.
3. Store corrections and outcome signals.
4. Add scheduled LLM extraction/consolidation for fields deterministic rules cannot safely infer.
5. Extend the dreaming/consolidation pass to emit candidate DSL rules as a promotion type (default path).
6. Only if recursive/meta-rule synthesis proves necessary, add an offline ILP job (Popper) as a fallback.
7. Review generated rules manually.
8. Promote accepted rules into the ingestion pipeline.
9. Measure whether LLM extraction calls decrease and classification consistency improves.

## Non-Goals

- Do not use Popper/Metagol in the live Slack response path. (They are now a fallback spike, not the default — see [Primary Approach](#primary-approach-dreaming-writes-the-rules).)
- Do not let the dreaming LLM emit arbitrary code or free-form Prolog; constrain it to the bounded predicate DSL, and gate every candidate rule before it goes live.
- Do not use learned rules as the only classifier.
- Do not learn from untrusted labels without review.
- Do not replace recall scoring or SQLite traversal with ILP.
- Do not put LLM extraction or rule learning in the per-message capture path.

## Fit With the Memory System

This feature strengthens [Associative Memory MVP](associative-memory.md) by improving the write path and the V2 consolidation engine. Better tags, event types, promotion decisions, archive decisions, stale-fact markings, and edges make recall better. It also strengthens [Memory-Informed Agent Selection](memory-informed-agent-selection.md) because routing decisions depend on stable routing memories like user preferences, repo aliases, task patterns, and prior corrections.

The key principle: **learn rules offline, apply accepted rules deterministically online.**
