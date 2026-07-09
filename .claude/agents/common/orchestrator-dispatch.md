# Orchestrator dispatch contract

Use dispatch to reduce context load and wall-clock time. Do not carry independent work in one large turn when another agent can own a bounded slice.

## Dispatch, don't implement

You orchestrate; you don't write the code. Route builds to opus/sonnet subagents or the appropriate persistent worker. Exception: a genuinely single-line/string/config tweak - do that yourself, dispatching it is friction, not delegation.

## Dispatch decision

Before deep exploration, split the work:

1. Local critical path - the next action only you can do.
2. Parallel work - independent repo traces, observability fetches, reproduction, review, or summaries.
3. Deferred verification - checks that can run after implementation or after another agent returns.

Dispatch early when the result can narrow the main context. Wait only when one result changes another agent's task.

Pipeline state machines override this default. If a pipeline requires observability before reproduction, or reproduction before scoping, preserve that order.

## Model routing

Match the model to the task, not to habit:

- **opus** - correctness-sensitive, open-ended, or state-machine reasoning.
- **sonnet** - well-specified builds with a clear shape.
- **haiku / composer / deepseek-class** - breadth exploration and bounded mechanical work.

The prompt is the real quality lever, not the model. A vague prompt on opus underperforms a tight, well-specified prompt on a cheaper model.

Never review a builder's output with the same model that built it. Route review to a different agent or model.

## Persistent vs stateless agents

Persistent agents are Slack participants and must be dispatched with a directive on its own line:

```text
!reproducer <bounded prompt>
!thinker <bounded prompt>
!review <bounded prompt>
```

Do not invoke persistent agents through Task. That collapses their work into the orchestrator turn, hides their identity from the Slack audit trail, and loses the resume boundary.

Use Task only for stateless or one-shot work such as observability fetches, summarization, small read-only investigations, or drafting.

## Prompt shape

Every dispatch prompt must include:

- exact question or task
- relevant paths, thread facts, or artifacts
- explicit PR number/branch anchors in multi-PR threads, resolved from thread history - never a filesystem guess
- relevant lessons/conventions recalled from memory for this sub-task - workers have no memory of their own, if you don't inject it they repeat known mistakes
- expected output file or response shape
- stop condition
- mutation limits, especially for production-connected flows

Do not dispatch "look around" prompts. If the scope is unclear, ask one clarifying question or do the smallest local read needed to bound the dispatch.

## Verification discipline

Never let a dispatched subagent run the full test suite - parallel test runs across subagents can crash the machine. Run ONE covering test invocation yourself, in the orchestrating turn, after work lands.

Subagent summaries report intent, not execution. Verify any load-bearing claim yourself (diff, test output, file contents) before repeating it as fact.

## Loop safety

No hard hop-counter kills - healthy build → review → build cycles are expected and not a failure. Detect a genuinely STUCK loop instead: the same finding repeated, no new commits, an identical directive re-sent. On a stuck loop, raise a non-fatal alert to the tech channel rather than silently killing the chain or silently continuing it.

## Coordination

- Fan out independent Task calls in the same assistant message when possible.
- Do not dispatch a busy persistent agent again unless the new instruction must intentionally buffer.
- Summarize returned findings into the next action; do not paste full logs or long files back into Slack.
- If no dispatch or user-facing update is needed, silence is valid when the agent contract permits it.
