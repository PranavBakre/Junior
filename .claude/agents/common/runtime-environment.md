# Runtime environment

Static facts. Do NOT spend tool calls discovering these.

> **Org-specific specifics** (concrete repo names, local dev URLs, credential file paths, impersonation flows) are appended below this section when an org context is configured. Treat the appended block as the source of truth for any value this section leaves abstract.

## Always read attached images

Whenever a Slack message includes an image (screenshot, photo, diagram), **read it before responding**. Don't acknowledge the image and proceed without examining it — visual evidence usually holds the most directly useful signal in a bug report (the broken UI, the error toast, the failing screen, the URL in the address bar). Skipping the image and responding from text alone produces shallow analysis and makes you re-ask things the user already showed you.

For browser screenshots specifically, extract:
- **URL from the address bar** — almost always there, almost always useful (it routes to the product, narrows the page, often contains the failing entity ID).
- **Page title and visible content** — what the user was looking at.
- **Visible errors / toasts / modals** — the user-facing failure mode.
- **Devtools / console output** if open — network failures, JS errors.
- **Browser tabs** — sometimes the user has the failing page AND a related context tab open; both are signal.

## Repo locations

**Repo paths for this thread are dynamic — read the `<workspace>` block at the top of your prompt.** When present, it lists each routed repo's per-thread worktree path, branch, and base. Use those paths for ALL reads, edits, and git commands.

Never touch repos outside the `<workspace>` block. If you need to touch a repo and there's no entry for it, STOP and post a Slack note instead of improvising. Durable pipeline dispatch provisions every configured run repo before your assignment starts; a missing entry is a control-plane state error to flag, not a reason to fall back to anything else. Outside a pipeline, the orchestrator may explicitly register a worktree.

**Always read each repo's `CLAUDE.md` before working in it.** Each product repo has its own conventions (naming, patterns, deprecated paths, test/build commands, gotchas). Read it from the worktree path in the workspace block. The repo's `CLAUDE.md` overrides anything generic — if it says "use X pattern," use X even if your default would have been Y.

## Local dev servers

Concrete services, ports, and start commands are in the org-specific section appended below. Use a fixed-port pattern — do NOT `lsof`/`ps`/`curl`-loop to discover ports.

## FE↔BE wiring

The active dev config and any production-like fallback paths (e.g. `/etc/hosts` SSL proxy) are in the org-specific section below. If a bug only reproduces on a non-default path, switch as described there.

## Available MCP tools

Pre-loaded — do NOT `ToolSearch` for them:

- **Slack bot** (HTTP MCP, runs in junior's process): `slack_send_message`, `slack_send_dm`, `slack_read_thread`, `slack_read_channel`, `slack_search`, `slack_search_users`, `slack_upload_file`, `pipeline_get_state`, `pipeline_report_outcome`, `pipeline_start_run`, `agent_dispatch`. Primary write paths for posting to Slack remain `slack_send_message` / `slack_send_dm`; they are audit communication, not execution transport. `agent_dispatch(mode="delegate"|"handoff")` creates the durable assignment transition. Pass `username` + `icon_emoji` per `AGENT_IDENTITIES` so attribution is correct.
- **MongoDB (read-only)**: `mcp__mongodb__find`, `mcp__mongodb__aggregate`, `mcp__mongodb__count`, `mcp__mongodb__collection-schema`, `mcp__mongodb__list-collections`, `mcp__mongodb__list-databases`. Use to verify data shape during research / reproduction. NEVER mutate.
- **Playwright** (browser automation, reproducer's primary tool): `mcp__playwright__browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_evaluate`, `browser_wait_for`, `browser_navigate_back`, `browser_fill_form`, `browser_close`.
- **Memory** (Junior-internal, `mcp__slack-bot__memory_*`): `memory_recall {query, repo?, kinds?, entity_refs?, limit?}` and `memory_add {text, kind?, repo?, tags?}`. Recall/add cadence lives in the core contract; `memory_add` only if the tool is in your `tools:` list.

## Admin credentials & access-gated reproduction

When a bug requires admin/impersonation access, the credential file path, admin-API impersonation flow, and any signed-URL conventions are in the org-specific section appended below. Read the credentials file by the path named there; never paste contents into prompts or commit them.

## Bug folder layout

Bugs live under `~/Projects/junior/support/bugs/<product>/<bug-id>/`. Canonical layout — DO NOT `ls` the bugs dir to discover this:

```
support/bugs/<product>/<bug-id>/
├── report.md           # bug intake (lead writes)
├── state.json          # status, rounds, gates (lead writes + updates)
├── research.md         # nr-research output (Task)
├── sentry.md           # sentry-fetch output (Task)
├── vercel.md           # vercel-status output (Task)
├── reproduction.md     # reproducer phase=reproduction (top of pipeline)
├── scoping.md          # orchestrator Phase-2 output
├── review.md           # review verdict summary — authored by review, persisted by the lead (review runs read-only); inline comments live on the GitHub PR
├── validation.md       # reproducer phase=validation (against local fix branch, before merge)
└── email.md            # email-drafter output (Task, optional)
```

`bug-id` format: `<8-hex-chars>` (first 8 of an upstream report ObjectId) or `bug-<YYYYMMDD>-<short-slug>` if there's no upstream report ID.

`state.json` shape (lead is the only writer):
```json
{
  "bugId": "<id>",
  "product": "<product>",
  "status": "intake | researching | reproducing | scoping | scope-pending-human | coding | reviewing | validating | done | needs-human",
  "rounds": { "research": 0, "review": 0, "reproducer": 0 },
  "caps":   { "research": 3, "review": 2, "reproducer": 2 },
  "created": "<ISO timestamp>",
  "slackChannel": "<channel-id>",
  "slackThread": "<thread-ts>"
}
```
