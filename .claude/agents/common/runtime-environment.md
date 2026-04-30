# Runtime environment

Static facts. Do NOT spend tool calls discovering these.

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

**NEVER use `~/openclaw-projects/<repo>/` directly.** Those bare repos are the human developer's working trees — touching them corrupts active branches. The canonical product → repo mapping lives in `~/Projects/junior/support/repo-routing.yaml` (reference only — don't cd into the paths it lists).

If you need to touch a repo and there's no entry for it in your `<workspace>` block, STOP and post a Slack note instead of improvising. The lead is responsible for registering the worktrees you need; if one is missing, that's a state error to flag, not a reason to fall back to the bare repo.

**Always read each repo's `CLAUDE.md` before working in it.** Each product repo has its own conventions (naming, patterns, deprecated paths, test/build commands, gotchas). Read it from the worktree path in the workspace block, not the bare repo. The repo's `CLAUDE.md` overrides anything generic — if it says "use X pattern," use X even if your default would have been Y.

## Local dev servers + FE↔BE wiring

Fixed ports — do NOT `lsof`/`ps`/`curl`-loop to discover them:
- Frontend: `http://localhost:3000` (gx-client-next, `pnpm dev`)
- Backend: `http://localhost:8000` (gx-backend, `pnpm dev`)

To check up:
```sh
curl -s -o /dev/null -w "fe=%{http_code} " http://localhost:3000
curl -s -o /dev/null -w "be=%{http_code}\n" http://localhost:8000
```

To start if down: `cd <repo-path>; pnpm dev`. Backend usually wants the frontend up too if the bug touches the UI.

**FE↔BE call path** (active dev config):

`gx-client-next/.env` sets `API_URL=http://localhost:8000/api/v1` and `COOKIE_DOMAIN=localhost`. So when you load the FE at `http://localhost:3000`, browser-side API calls go directly to `http://localhost:8000` (NOT through `backend-local.growthx.club`). Cookies are per-host and apply to both `localhost:3000` and `localhost:8000`, so auth carries automatically once cookies are set on the `localhost` domain.

Some FE calls go through Next.js API routes (server-side proxies running in the Next.js process at port 3000) — e.g. `GET /api/proof-of-works/<id>` hits a Next.js handler that itself calls the backend. These show up in the network tab as `localhost:3000/api/...` even though they ultimately resolve to backend logic.

**Parallel "production-like" path (NOT current default):** `/etc/hosts` maps `community-local.growthx.club` and `backend-local.growthx.club` to `127.0.0.1`. A local reverse proxy (nginx/Caddy with self-signed SSL) listens on 443 and forwards to the same dev servers. Activated by uncommenting `API_URL=https://backend-local.growthx.club/api/v1` and changing `COOKIE_DOMAIN` to `.growthx.club`. If the bug is reproducible only at the prod-like FQDN (cookies, SSL, CORS specifics), switch to this path.

## Available MCP tools

Pre-loaded — do NOT `ToolSearch` for them:

- **Slack bot** (HTTP MCP, runs in junior's process): `slack_send_message`, `slack_read_thread`, `slack_read_channel`, `slack_search`, `slack_search_users`, `slack_upload_file`. Primary write path for posting to Slack. Pass `username` + `icon_emoji` per `AGENT_IDENTITIES` so attribution is correct.
- **MongoDB (read-only)**: `mcp__mongodb__find`, `mcp__mongodb__aggregate`, `mcp__mongodb__count`, `mcp__mongodb__collection-schema`, `mcp__mongodb__list-collections`, `mcp__mongodb__list-databases`. Use to verify data shape during research / reproduction. NEVER mutate.
- **Playwright** (browser automation, reproducer's primary tool): `mcp__playwright__browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_evaluate`, `browser_wait_for`, `browser_navigate_back`, `browser_fill_form`, `browser_close`.

## Admin credentials

`~/Projects/junior/support/admin-credentials.yaml` (gitignored) holds the superadmin login + admin-API impersonation flow + Cloudfront signed-URL flow. The reproducer uses these for access-gated bugs (403 → impersonate as the affected user → re-call). Read this file directly when you need the exact API sequence — don't re-derive it.

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
├── scoping.md          # thinker output (after !thinker)
├── review.md           # review output (after !review) — verdict summary; inline comments live on the GitHub PR
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
