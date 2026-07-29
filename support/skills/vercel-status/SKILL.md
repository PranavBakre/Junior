---
name: vercel-status
description: Inspect Vercel deployment state for a Junior pipeline assignment and record bounded evidence.
---

# Vercel deployment status

Use only the read-only Vercel tools available to this run. Inspect the
assignment's requested projects and environments. Do not post directly to
Slack.

Write `vercel.md` with `pipeline_write_artifact`, using the authoritative
`run_id` and `assignment_id` from `<pipeline-assignment>`. Include:

- project and environment
- latest deployments and commit SHAs
- deployment timing relative to the report
- failures, rollbacks, or suspicious changes
- confidence and evidence gaps

Before returning, call `pipeline_report_outcome` for the exact assignment with
`action: complete`, the artifact reference, and a stable progress fingerprint.
Return one concise line: `DONE: <key finding> - see vercel.md`.
