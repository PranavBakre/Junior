# Memory-Informed Agent Selection

## Problem

Agent selection and memory recall are separate features, but they should cooperate. Junior's router needs to choose an agent/action from the current Slack message, thread state, channel defaults, target repo, and available agents. Some of the best routing evidence lives in memory: previous user corrections, channel-specific behavior, project naming patterns, repeated task shapes, and lessons learned from bad dispatches.

**Who has this problem:** The agent router and session manager.
**What happens today:** Routing is command/default/keyword driven. It does not learn much from prior routing outcomes.
**Painful part:** The same phrase can mean different things by user, channel, repo, or prior history. A message like "check this dashboard bug again" is ambiguous without recalled context.
**"Finally" moment:** Junior recalls that this user usually means `gx-admin-client` when saying "dashboard", remembers that a previous dashboard task was corrected from `build` to `frontend`, and routes to the right agent with an explainable reason.

## Relationship to Other Features

This is adjacent to, but not the same as:

- [Agent Routing](agent-routing.md) — owns agent definitions, command overrides, and dispatch mechanics.
- [Associative Memory MVP](associative-memory.md) — owns raw events, tags/entities, edges, FTS, recall, and lessons.

The boundary:

```text
Memory Recall = evidence provider
Agent Selection = decision engine
```

Memory recall should not directly dispatch agents. It should return evidence that the routing engine can evaluate alongside current message/session facts.

## Core Idea

Use the neuro-symbolic pattern where it fits best:

```text
LLM extracts/normalizes facts from language
  ↓
memory recall finds prior relevant evidence
  ↓
deterministic rules choose route/action when possible
  ↓
LLM fallback only when ambiguity remains
```

Agent selection is a bounded decision problem, so it maps better to symbolic rules than open-ended memory recall does.

## Recommended V1

Implement memory-informed routing as an additive decision layer inside the existing dispatcher flow.

1. Keep `AgentDispatcher` as the only place that turns Slack messages into dispatch calls.
2. Parse explicit directives and built-in commands before consulting memory.
3. Add a `RoutingMemoryProvider` interface that can be stubbed in tests and backed by associative memory later.
4. Start with deterministic message facts: explicit command, directive agent names, repo mentions from configured repo names/aliases, PR URLs, file extensions, channel id, thread id, sender kind, and session state.
5. Feed only routing-scoped recalled facts into the router: repo aliases, user preferences, channel patterns, task patterns, and prior routing corrections.
6. Return a `RoutingDecision` with reasons and `usedMemoryIds`, then execute it through the existing session manager.
7. Persist routing decisions and corrections as memory events after dispatch, not during recall.

V1 should route better in repeated cases without changing Junior's safety model. Explicit commands, support-channel behavior, self-bot loop guards, worker dispatch allow-lists, and busy buffering remain authoritative.

## Recommended V2

After V1 has real routing outcomes:

1. Learn repo aliases and user/channel preferences from repeated accepted corrections.
2. Add a low-confidence clarification path for ambiguous repo/agent choices.
3. Let LLM extraction normalize task shape only when deterministic extraction is insufficient.
4. Add reason traces to Slack status/debug surfaces so operators can see which memory influenced a route.
5. Add decay/supersession for stale routing memories, especially repo aliases and user preferences.
6. Let the memory consolidation engine promote repeated routing outcomes into durable routing memories, but keep those memories as evidence for the router rather than commands.

V2 should improve autonomy, but memory still provides evidence. It should never directly dispatch agents or override explicit user intent.

## Flow

```text
Incoming Slack message
  ↓
Extract current message facts
  - explicit command
  - mentioned agent/repo
  - task type
  - stack/file hints
  - urgency/blocker language
  ↓
Recall routing-relevant memory
  - prior user preferences
  - channel behavior
  - repo/task naming patterns
  - previous routing corrections
  - repeated blockers/outcomes
  ↓
Build routing context
  - message facts
  - session facts
  - recalled facts/lessons
  - available agents
  ↓
Apply routing rules
  - command overrides first
  - safety/session-state rules
  - memory-informed preferences
  - task-shape rules
  - fallback/default rules
  ↓
Output routing decision
  - dispatch agent
  - ask clarification
  - buffer
  - ignore/reject
```

## Routing Input and Output

```ts
type ExtractedMessageFacts = {
  explicitCommand?: string;
  mentionedAgents: string[];
  mentionedRepos: string[];
  taskTypes: string[];
  technologies: string[];
  files: string[];
  urgency?: "low" | "normal" | "high";
};

type ThreadSessionFacts = {
  channelId: string;
  threadId: string;
  currentAgent?: string;
  status: "idle" | "busy" | "draining";
  targetRepos: string[];
  defaultAgent?: string;
};

type RecalledRoutingFact = {
  id: string;
  kind:
    | "user_preference"
    | "channel_pattern"
    | "repo_alias"
    | "routing_correction"
    | "task_pattern"
    | "lesson";
  body: string;
  confidence: number;
  sourceEventId?: string;
  validAt?: number;
  invalidAt?: number;
  supersededBy?: string;
  reason: string;
};

type RoutingInput = {
  messageFacts: ExtractedMessageFacts;
  sessionFacts: ThreadSessionFacts;
  recalledFacts: RecalledRoutingFact[];
};

type RoutingDecision = {
  action: "dispatch_agent" | "ask_clarification" | "buffer" | "ignore";
  agent?: "build" | "frontend" | "review" | "lead" | "reproducer" | "thinker" | "architect" | "pm";
  repo?: string;
  confidence: number;
  reasons: string[];
  usedMemoryIds: string[];
};
```

## What Memory Should Surface for Routing

Recall should prefer memory that changes the routing decision:

### User Preferences

Examples:

- User prefers terse review unless asked for detail.
- User often uses "dashboard" to mean `gx-admin-client`.
- User wants bugs routed through lead/reproducer/thinker first.

### Channel Patterns

Examples:

- `#agent-test` is usually experimentation/default Junior.
- A bug-backlog channel defaults to `lead`.
- A review channel usually routes PR URLs to `review`.

### Repo Aliases and Naming Patterns

Examples:

- "admin dashboard" → `gx-admin-client`.
- "web app" → `gx-client-next`.
- "API" / "backend" → `gx-backend`.

Alias source matters. V1 aliases should come from config and curated operator facts. V2 aliases can be promoted from accepted corrections and dreaming-generated proposals. See [Dictionary and Alias Population](associative-memory.md#dictionary-and-alias-population). Learned aliases are routing evidence with confidence and validity, not hard dispatch commands.

### Prior Routing Corrections

Examples:

- "Last time this was routed to `build`, user corrected to `frontend`."
- "Last dashboard styling task needed frontend design rules."
- "Old repo alias was superseded after the project split; ignore it unless the query is historical."

### Task Patterns and Lessons

Examples:

- "PR #..." should use review.
- "Reproduce this UI bug" should use reproducer first.
- "Implement/fix backend endpoint" should use build.

## Rule Ordering

Routing rules should be ordered so memory informs decisions without overriding explicit intent.

1. **Parse explicit command/directive first.** `!review`, `!build`, `!frontend`, etc. define the intended target before memory is consulted.
2. **Safety/session state gates execution.** If the selected target is busy, buffer instead of dispatching a second runner.
3. **Hard channel defaults apply.** Admin-configured channel defaults beat learned soft preferences.
4. **Memory-informed rules apply.** Recalled user/channel/repo/task evidence adjusts agent and repo choice.
5. **Task-shape rules apply.** Keyword/structure rules handle obvious cases.
6. **Fallback/default applies.** If confidence is low, ask a clarifying question or use the session/default agent.

This distinction matters: explicit intent wins the routing decision, but the session manager still decides whether the chosen target can run immediately or must buffer.

Every branch that returns `dispatch_agent`, including memory-informed correction branches, should pass through the same session gate before execution.

## Example Rules in TypeScript

Start with pure TypeScript. Do not add Prolog until the rule set becomes painful to maintain.

```ts
function selectAgent(input: RoutingInput): RoutingDecision {
  const { messageFacts, sessionFacts, recalledFacts } = input;

  if (messageFacts.explicitCommand) {
    const decision = commandDecision(messageFacts.explicitCommand, input);
    return applySessionGate(decision, sessionFacts);
  }

  const correction = recalledFacts.find(
    (fact) => fact.kind === "routing_correction" && fact.confidence >= 0.8,
  );
  if (correction?.body.includes("frontend")) {
    return applySessionGate({
      action: "dispatch_agent",
      agent: "frontend",
      confidence: 0.86,
      reasons: [`Prior routing correction applies: ${correction.reason}`],
      usedMemoryIds: [correction.id],
    }, sessionFacts);
  }

  if (messageFacts.taskTypes.includes("pr_review")) {
    return applySessionGate({
      action: "dispatch_agent",
      agent: "review",
      confidence: 0.9,
      reasons: ["Message shape indicates PR/code review."],
      usedMemoryIds: [],
    }, sessionFacts);
  }

  return applySessionGate({
    action: "dispatch_agent",
    agent: sessionFacts.defaultAgent ?? "build",
    confidence: 0.55,
    reasons: ["No stronger route matched; using default agent."],
    usedMemoryIds: [],
  }, sessionFacts);
}

function applySessionGate(
  decision: RoutingDecision,
  sessionFacts: ThreadSessionFacts,
): RoutingDecision {
  if (decision.action !== "dispatch_agent") return decision;
  if (sessionFacts.status !== "busy") return decision;
  return {
    action: "buffer",
    agent: decision.agent,
    repo: decision.repo,
    confidence: 1,
    reasons: [
      ...decision.reasons,
      "Selected target is already running a turn; buffering this message.",
    ],
    usedMemoryIds: decision.usedMemoryIds,
  };
}
```

## Where Prolog-Style Querying Fits

The GitHub neuro-symbolic demo pattern — natural language to symbolic query to deterministic result — maps well to routing, but the safe version is:

```text
LLM extracts facts
fixed routing query runs
rules decide
```

Not:

```text
LLM writes arbitrary Prolog
runtime executes arbitrary query
```

If the routing rule set outgrows TypeScript, the migration path is:

1. keep SQLite as source of truth;
2. compile selected routing facts into a Datalog/Prolog-style fact set;
3. expose a fixed query like `select_agent(ContextId, Agent, Repo, Reason)`;
4. validate allowed predicates and cap evaluation time/depth;
5. return proof/reason traces to Junior.

For MVP, TypeScript rules are enough and match the codebase.

### The DSL is the contract between extraction and execution — not between model and host

The single most important rule for keeping this safe: **the LLM never authors a query, and never emits DSL/Prolog text. It emits validated structured facts; the host compiles those into DSL terms and runs a fixed, host-authored goal.**

```text
LLM emits (data, schema-validated tool args):
  { "mentions": ["css"], "hasPrUrl": true, "channel": "c123" }

host compiles → asserts (DSL terms, internal):
  mentions(ctx, css).  has_pr_url(ctx).  channel(ctx, c123).

host runs FIXED goal:
  ?- select_agent(ctx, Agent, Repo, Why).

returns:
  { agent: "frontend", repo: "gx-admin-client", proof: [...] }
```

This works because **LLM tool-calling is already structured JSON validated against a tool's input schema** — so the fact-assertion tool's schema *is* your bounded fact vocabulary (enumerated predicates, fixed arities, typed values). Having the model emit Prolog/DSL text would mean stuffing a string blob into a tool argument and throwing away that validation for free.

Two interfaces that must never be collapsed:

1. **Fact-assertion** — where natural language enters. Structured, schema-validated, bounded predicate set. Deterministic extraction for what parses cheaply; a constrained LLM call only for the rest.
2. **Query** — fixed, host-authored goals exposed as named tools (`select_agent`, etc.). The model picks a tool and supplies typed params; it never composes the query body.

Why JSON-then-compile, not raw DSL from the model:

- **Validation before it becomes code.** Reject `"css; route(ctx, admin)"` at the schema, instead of sanitizing DSL syntax — that parse step is the injection surface you are trying to avoid.
- **Bounded vocabulary for free.** No schema field for `frobnicate(...)`, so the model cannot invent it.
- **Swappable executor.** The same validated facts run through a TypeScript evaluator *or* a Prolog engine. Emitting DSL text hard-couples the model to one executor.

**Executor choice — earn the runtime.** Flat classification/routing (`tag(E, frontend) :- mentions(E, css)`, `route(Ctx, review) :- has_pr_url(Ctx)`) runs fine in a small TypeScript evaluator with zero new dependencies. Reach for an in-process Prolog engine such as `tau-prolog` (pure-JS npm package — no second runtime, no Python/SWI install) only when rules genuinely need recursion / backward-chaining or you want real proof trees for multi-hop "why" reasoning over edges. The "second runtime" objection only ever applied to the ILP *learners* (Popper/Metagol), not to an in-process query engine.

Honest caveat: you *can* let the model emit DSL term strings directly **if** you use grammar-constrained decoding to force valid syntax and the allowed predicate set. Absent that hard grammar, free-text DSL from an LLM produces syntax slips and hallucinated predicates — so JSON-schema-then-compile is the safer default.

### Decisions vs recall — two engines, two return types

Routing/classification (this doc) is a **decision**: structured facts in → fixed goal → a verdict + proof trace, consumed by *code*. Episodic recall (see [Associative Memory MVP](associative-memory.md)) is **retrieval**: structured `recall(terms, filters)` in → FTS seeds + bounded traversal + scoring → ranked text snippets + provenance, consumed by the *LLM* to read. The same graph serves both; only the return type differs. Do not push narrative recall through the symbolic query engine — reading the actual text is the entire point of recall.

## Learning Loop

Routing should write outcomes back into memory.

```text
route
  ↓
observe outcome/correction
  ↓
store event/lesson
  ↓
recall next time
  ↓
route better
```

Examples of routing events to store:

- selected agent and repo;
- confidence and reasons;
- recalled memories used;
- whether user corrected the route;
- whether the dispatched agent completed successfully;
- whether a reviewer/user said the route was wrong.

High-value corrections should become lessons, for example:

```text
Lesson: For Pranav, "dashboard" usually means gx-admin-client/frontend unless API/backend is explicitly mentioned.
Source events: route_event_..., correction_event_...
```

Repeated routing outcomes should first be stored as source events. The consolidation engine can later promote stable patterns into routing memories such as repo aliases, channel defaults, and user preferences. The hot routing path should not call an LLM for every Slack message just to learn a preference; it should consume already-stored routing memories and persist new outcomes for offline promotion.

## MVP Build Order

1. Add routing decision types and reason traces.
2. Extract current message facts before agent selection.
3. Add a recall call that requests routing-relevant memories only.
4. Feed recalled facts into routing decisions.
5. Add TypeScript rules for user preference, channel pattern, repo alias, and prior correction.
6. Persist routing outcomes/corrections as memory events.
7. Add tests for explicit-command priority, busy buffering, memory-informed routing, low-confidence clarification, and correction learning.

## Non-Goals

- Do not let memory dispatch agents directly.
- Do not let an LLM generate arbitrary executable routing rules on the hot path.
- Do not let the LLM author queries or emit DSL/Prolog text. It asserts validated structured facts; the host runs fixed goals. (See [The DSL is the contract between extraction and execution](#the-dsl-is-the-contract-between-extraction-and-execution--not-between-model-and-host).)
- Do not add Prolog/graph/vector infrastructure for MVP.
- Do not override explicit user commands with learned preferences.
- Do not run expensive memory extraction in the dispatch hot path.

## Fit With the Existing System

This extends [Agent Routing](agent-routing.md) without replacing it:

- agent definition loading remains unchanged;
- explicit commands remain authoritative;
- channel defaults still work;
- memory recall supplies additional evidence;
- final dispatch still goes through the existing session/runner lifecycle.

The feature depends on [Associative Memory MVP](associative-memory.md) for recalled facts, but can start with a stubbed recall provider that returns curated routing memories for tests.
