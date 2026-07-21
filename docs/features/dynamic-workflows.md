# Dynamic Workflows

> **Current status (2026-07-21):** Shipped. The registry, SQLite state/run store, hot reload, scheduler, Slack commands, and localhost dashboard endpoint are live. Current definitions include `worklog`, `release-notes`, `memory-consolidation`, and `worktree-prune`; private overlays may add or override definitions.

## Problem

Junior needs recurring and on-demand workflows that can be added without restarting the bot. The first workflow is a daily worklog: collect my PRs and commits, turn them into grouped "things I did", store a markdown artifact, and post a Slack summary.

**Who has this problem:** Junior operators who need repeatable automation.
**What happens today:** Workflow definitions are discovered from `workflows/` and `agents-org/workflows/`, reloaded on file changes, persisted in SQLite, and controllable through `!workflow` / `!workflows`. The dashboard exposes the same state at `GET /api/workflows`.
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
  idleTimeoutMs: 300000
  maxIdleInterrupts: 3
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
| `runner` | no | Optional agent execution step. Runner workflows execute from `/tmp/junior-utility`; workflow definitions are trusted config, not a sandbox boundary. `idleTimeoutMs` and `maxIdleInterrupts` opt into the CLI SIGINT/resume fallback for silent runner processes. |
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
- `memory.read` — recall v3 memory (claims/profiles) through the memory CLI/tool surface
- `memory.write` — add claims / run the v3 consolidation sweep through memory code
- `memory.evaluate` — inspect consolidation sweep reports (episodes/profiles/claims)

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

The v3 memory consolidation ("dreaming") engine uses this workflow system rather than a bespoke scheduler. The `memory-consolidation` workflow runs the shared `runConsolidationSweep` helper (the same path the `consolidate-v3` CLI and the `memory_consolidate` MCP tool use); it can run on a cron schedule and by owner/admin command, skip overlapping runs with `concurrency: skip`, write artifacts under `data/workflow-runs/memory-consolidation`, and optionally post a compact Slack summary. See [memory-system-v3.md](memory-system-v3.md) §7.

The sweep itself is the LLM pass — it spawns the runner (`claude -p`) per session to derive episodes/profiles/claims; the workflow definition does not place that logic in prompt prose. Workflow utility runs skip Junior's project MCP wiring because they run from `/tmp/junior-utility`, so a manual sweep can also go through the CLI surface:

```bash
bun run <runtime context junior.memoryCli> consolidate-v3 --json
bun run <runtime context junior.memoryCli> recall-claims --query "dashboard routing" --json
```

The CLI uses `MEMORY_DB_PATH` when set, otherwise `data/memory.db`. Because workflow runners execute from `/tmp/junior-utility`, the runtime context includes `junior.projectRoot` and `junior.memoryCli` absolute paths. Normal Junior runner sessions with MCP wiring can use `memory_recall`, `memory_add`, and `memory_consolidate` instead.

### Runner idle interrupt fallback

Workflow runner configs can set `idleTimeoutMs` to recover from a silent CLI run before the hard `timeoutMs` expires. The executor starts an idle timer for each CLI attempt and resets it on every normalized runner event. When the timer fires, Junior sends `SIGINT` to the provider process, waits up to 10 seconds for it to exit, then sends `SIGKILL` as a cleanup fallback. If the run has already emitted a provider session id, Junior immediately spawns a new `opencode run --session <id>` / `claude --resume <id>` attempt with a compact "continue from the last completed step" prompt. `maxIdleInterrupts` bounds the number of resume attempts; after that, the run fails normally.

This is a CLI fallback, not OpenCode's native server interrupt. The implemented OpenCode SDK/server provider uses provider-native abort semantics; the fallback applies to silent CLI workflow attempts.

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

The localhost dashboard already exposes workflow definitions, state, recent runs,
and registry errors through `GET /api/workflows`; a richer interactive UI remains
out of scope.
