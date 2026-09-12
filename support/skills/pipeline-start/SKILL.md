---
name: pipeline-start
description: Promote an ordinary Junior task into a durable product or bug pipeline when coordinated execution is warranted.
---

# Deliberate pipeline upgrade

Every ordinary task already has a lightweight `default` run. Deliberately
promote that same run in place with `mcp__slack-bot__pipeline_start_run` when a
product or bug controller is now useful.

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
Before calling the tool, resolve the repository scope from explicit repo names,
PR links, report URLs, and the repository routing map. In support threads,
consult `support/repo-routing.yaml`; include every routed repo needed to trace
the reported path. If the routing evidence has one clear answer, pass those
names in `repo_refs`. If it is materially ambiguous, ask one precise repository
question and do not start the pipeline yet.

Raw bug reports normally start with `bug` + `debug` so Junior can triage the
report, determine the repo scope, classify read-only versus write-path behavior,
and only then dispatch a worker. Use `bug` + `reproducer` as the initial stage
only when repository scope is already bound and live reproduction is known to
be safe. Never start a `reproducer` or product `build` with empty `repo_refs`;
the runtime rejects these starts before promotion so an impossible assignment
cannot strand the run in `needs-human`.

For a product `build`, pass `required_workstreams` explicitly from the actual
change scope: `backend`, `frontend`, or both. Do not infer full-stack work just
because the request mentions an existing API while asking for a UI change.
State the concrete coordination reason and use a stable idempotency key for
this source turn. An accepted or reused receipt means the typed assignments are
already durably queued. After the tool accepts the upgrade, do not also emit a legacy
`!build`, `!debug`, or duplicate worker directive. The durable initial
assignment has already been queued; yield after a concise acknowledgement.
