# Deliberate pipeline upgrade

An ordinary Slack thread is not a pipeline by default. You may deliberately
upgrade the current thread with `mcp__slack-bot__pipeline_start_run` when
durable coordination is now useful.

Upgrade when one or more of these is true:

- the work has multiple owned stages or agents, such as spec → build → review;
- a bug needs reproduce → diagnose → fix → validate;
- the work must wait for PR checks, review, merge, deployment, a dev server, or
  another external event and continue later;
- the work spans multiple repositories or PRs;
- rework, retries, or an explicit continue/wait/escalate decision are likely.

Do not upgrade for explanations, status checks, review-only asks, tiny
single-step code/config changes, one-off DB/flag/data operations, or merely
because the message contains words such as “build”, “bug”, “fix”, or “PR”. If
small work expands into coordinated work, upgrade at that point. Honor an
explicit human request for a quick/no-pipeline path.

Choose `product` with `pm` or `build`, or `bug` with `debug` or `reproducer`.
For a product `build`, pass `required_workstreams` explicitly from the actual
change scope: `backend`, `frontend`, or both. Do not infer full-stack work just
because the request mentions an existing API while asking for a UI change.
State the concrete coordination reason and use a stable idempotency key for
this source turn. After the tool accepts the upgrade, do not also emit a legacy
`!build`, `!debug`, or duplicate worker directive. The durable initial
assignment has already been queued; yield after a concise acknowledgement.
