# Orchestrator dispatch contract

Use dispatch to reduce context load and wall-clock time. Do not carry independent work in one large turn when another agent can own a bounded slice.

## Dispatch decision

Before deep exploration, split the work:

1. Local critical path - the next action only you can do.
2. Parallel work - independent repo traces, observability fetches, reproduction, review, or summaries.
3. Deferred verification - checks that can run after implementation or after another agent returns.

Dispatch early when the result can narrow the main context. Wait only when one result changes another agent's task.

Pipeline state machines override this default. If a pipeline requires observability before reproduction, or reproduction before scoping, preserve that order.

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
- expected output file or response shape
- stop condition
- mutation limits, especially for production-connected flows

Do not dispatch "look around" prompts. If the scope is unclear, ask one clarifying question or do the smallest local read needed to bound the dispatch.

## Coordination

- Fan out independent Task calls in the same assistant message when possible.
- Do not dispatch a busy persistent agent again unless the new instruction must intentionally buffer.
- Summarize returned findings into the next action; do not paste full logs or long files back into Slack.
- If no dispatch or user-facing update is needed, silence is valid when the agent contract permits it.
