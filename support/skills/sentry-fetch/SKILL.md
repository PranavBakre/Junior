---
name: sentry-fetch
description: Investigate Sentry issues for a Junior pipeline assignment and record bounded evidence.
---

# Sentry evidence

Use the installed `sentry-cli` only for read operations. Investigate the
assignment's requested time window and scope. Do not post directly to Slack.

Write `sentry.md` with `pipeline_write_artifact`, using the authoritative
`run_id` and `assignment_id` from `<pipeline-assignment>`. Include:

- query and time window
- matching issues and exception classes
- affected users or counts
- visible release or deployment correlation
- confidence and evidence gaps

Before returning, call `pipeline_report_outcome` for the exact assignment with
`action: complete`, the artifact reference, and a stable progress fingerprint.
Return one concise line: `DONE: <key finding> - see sentry.md`.
