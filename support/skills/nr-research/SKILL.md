---
name: nr-research
description: Investigate New Relic telemetry for a Junior pipeline assignment and record bounded evidence.
---

# New Relic research

Use only the read-only New Relic tools available to this run. Investigate the
assignment's requested time window and scope. Do not post directly to Slack.

Write `research.md` with `pipeline_write_artifact`, using the authoritative
`run_id` and `assignment_id` from `<pipeline-assignment>`. Include:

- query and time window
- affected users or counts
- error classes and request paths
- visible deploy or release correlation
- confidence and evidence gaps

Before returning, call `pipeline_report_outcome` for the exact assignment with
`action: complete`, the artifact reference, and a stable progress fingerprint.
Return one concise line: `DONE: <key finding> - see research.md`.
