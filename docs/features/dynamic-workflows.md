# Dynamic Workflows

## Problem

Junior needs recurring and on-demand workflows that can be added without restarting the bot. The first workflow is a daily worklog: collect my PRs and commits, turn them into grouped "things I did", store a markdown artifact, and post a Slack summary.

**Who has this problem:** Junior operators who need repeatable automation.
**What happens today:** Work has to be prompted manually or hard-coded into the bot.
**Painful part:** Every new cron-like behavior currently risks becoming a code deploy.
**"Finally" moment:** Add or edit `workflows/worklog.workflow.md`; Junior reloads it, schedules it, and owners can `!workflow run worklog` or `!workflow stop worklog` from Slack.

## Source Layout

Workflow files are markdown files with YAML frontmatter and a prompt body.

Junior loads only these fixed roots:

- `workflows/*.workflow.md` — public repo workflows
- `agents-org/workflows/*.workflow.md` — private/org overlay workflows

There is no `WORKFLOW_DIRS` environment variable. `docs/` is for Junior documentation, not executable workflow definitions.

Overlay precedence:

1. `agents-org/workflows/<name>.workflow.md` overrides `workflows/<name>.workflow.md`.
2. If an edited overlay becomes invalid, Junior keeps the last-known-good overlay in memory and reports the validation error.
3. Junior does not silently fall back to the public workflow while an overlay with the same name is invalid.
4. If a valid workflow file is deleted, the workflow is removed on the next reload.

Submodule contract:

- `.gitmodules` is the authoritative source for mounted submodules.
- The private agent/identity submodule may provide `agents-org/workflows/`.
- Identity documents in the private submodule follow the existing `identity/<persona>/IDENTITY.md` and `identity/<persona>/SOUL.md` structure. Workflow docs reference that structure only as a contract; they do not duplicate persona details.

## Workflow Schema

```yaml
---
name: worklog
enabled: true
description: Daily PR and commit worklog
ownerSlackUserIds:
  - U123ABC
triggers:
  - type: schedule
    cron: "0 18 * * 1-5"
    timezone: Asia/Kolkata
  - type: command
    command: worklog
outputs:
  - type: docs
    path: data/workflow-runs/worklog
  - type: slack
    channel: C123ABC
permissions:
  repos:
    - junior
  tools:
    - git
    - gh
    - docs.write
    - slack.post
runner:
  provider: default
  agentName: lead
  timeoutMs: 300000
concurrency: skip
---

Collect PRs and commits from the last 24 hours. Group them by meaningful work item.
Keep the Slack output compact.
```

Fields:

| Field | Required | Notes |
|---|---:|---|
| `name` | yes | Lowercase kebab-case. Must match `<name>.workflow.md`. |
| `enabled` | yes | File-level kill switch. `false` prevents start/run/schedule even if DB status says active. |
| `description` | no | Human-readable summary. |
| `ownerSlackUserIds` | yes | Slack users allowed to run/start/stop this workflow. May be empty for admin-only workflows. Admins are always allowed. |
| `triggers` | yes | At least one schedule, command, or Slack event trigger. |
| `outputs` | yes | At least one output. Docs output must stay under `data/workflow-runs/<workflow>`. |
| `permissions` | yes | Capability declaration used by workflow validation and runtime prompts. `repos` may be omitted to use all configured repos, or listed to narrow access. |
| `runner` | no | Optional agent execution step. Runner workflows execute from `/tmp/junior-utility`; workflow definitions are trusted config, not a sandbox boundary. |
| `fallback` | no | Reserved for future fallback modes. |
| `concurrency` | no | `skip` by default. `parallel` is allowed for workflows that can overlap safely. |

Trigger schema:

```yaml
triggers:
  - type: schedule
    cron: "0 18 * * 1-5"
    timezone: Asia/Kolkata
  - type: command
    command: worklog
  - type: slack-event
    channel: C123ABC
    pattern: "\\bworklog\\b"
```

Command triggers must not collide with built-in Junior commands. Unknown `!<command>` messages are left intact by the Slack parser, so the workflow controller can match dynamic command triggers before normal agent dispatch.

Output schema:

```yaml
outputs:
  - type: docs
    path: data/workflow-runs/worklog
  - type: slack
    channel: C123ABC
    threadTs: "1710000000.000000"
  - type: slack-thread
    channel: C123ABC
```

Permission tools:

- `git` — read local Git history
- `gh` — read GitHub PR metadata with the GitHub CLI
- `docs.write` — write run artifacts under `data/workflow-runs/`
- `slack.post` — post Slack summaries

`permissions.tools` is not a general runner sandbox. It is validated and injected into the runner prompt as the declared capability contract. Workflow definition files are trusted operational config; private overlays should be reviewed like code.

Repository scope:

- Omit `permissions.repos` to run against every repo in `REPOS`.
- Set `permissions.repos` to a list of repo names to narrow access.
- Listed repo names are validated against configured `REPOS` at load time.

## Runtime State

Runtime artifacts:

- `data/workflow-runs/<workflow>/<date>-<runId>.md`

SQLite tables:

- `workflow_states`
- `workflow_runs`

Workflow state:

| Status | Meaning |
|---|---|
| `active` | Schedule, command, and event triggers may run when the file is enabled. |
| `stopped` | Runtime stop set by `!workflow stop <name>`. Manual `run` still requires owner/admin and file enabled. |
| `invalid` | Reserved for invalid loaded state. Invalid file edits currently stay in registry errors while last-known-good remains active. |

Effective state is computed as:

```text
file enabled === true AND workflow_states.status === active
```

If the file says `enabled: false`, it wins. `!workflow start <name>` refuses to start it until the file is changed back to `enabled: true`.

## Slack Commands

Read commands:

- `!workflows`
- `!workflow show <name>`
- `!workflow logs <name>`

Owner/admin commands:

- `!workflow run <name>`
- `!workflow stop <name>`
- `!workflow start <name>`
- Custom workflow commands, for example `!worklog`
- Human-triggered `slack-event` workflows

Admin-only commands:

- `!workflow reload`

Authorization uses existing Junior admins plus `ownerSlackUserIds` from the workflow file. Non-authorized mutating commands are rejected with a reaction and no workflow run.

## Hot Reload

Junior uses `fs.watch` on both fixed workflow roots. Watch events are debounced and followed by a full rescan of each root because file watchers can coalesce, duplicate, or miss exact filenames across platforms.

Manual reload still exists:

- `!workflow reload` forces a rescan.
- It is a diagnostic/repair command, not the normal way to deploy workflows.
- It is useful when a root was missing at boot, a watcher errored, or an operator wants immediate feedback after repairing a validation error.

Start/stop commands do not reload files. They only mutate runtime state:

- `!workflow stop <name>` writes `stopped` and cancels scheduled timers.
- `!workflow start <name>` writes `active` and reschedules, but only if the file is enabled.

## Worklog Workflow

`workflows/worklog.workflow.md` is an agent-run workflow. The scheduler triggers
the markdown definition, the executor spawns the configured runner from
`/tmp/junior-utility`, and the runner uses the supplied repo paths plus the
workflow prompt to collect Git/GitHub activity and return a Slack-ready summary.
Junior then writes that final response under `data/workflow-runs/worklog/` and
posts it to configured Slack outputs.

## Memory Consolidation Workflow

The V2 associative-memory consolidation/"dreaming" engine should use this workflow system rather than a bespoke scheduler. A memory workflow can run on a cron schedule and by owner/admin command, skip overlapping runs with `concurrency: skip`, write artifacts under `data/workflow-runs/memory-consolidation`, and optionally post a compact Slack summary.

The workflow definition should orchestrate memory-specific code/tools; it should not place all classification, promotion, archive, and stale-fact logic in prompt prose. If memory consolidation needs new permissions, add narrow workflow tools such as `memory.read`, `memory.write`, and `memory.evaluate`.

## Dependencies

- Slack Event Handler — must leave unknown `!<command>` text intact.
- Thread Commands — reserves built-in command names and provides admin identity.
- Runner Providers — optional summarization/compression.
- Session SQLite DB — stores workflow state and run history.
- `cron-parser` — computes next scheduled runs with timezone support.
- `yaml` — parses workflow frontmatter.

## Cut List

- Interactive workflow creation from Slack.
- Multi-step workflow DAGs.
- Retrying failed workflow runs.
- Per-output templates.
- Workflow-specific secrets.
- A UI for workflow states and history.
