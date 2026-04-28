# Runtime environment

Static facts. Do NOT spend tool calls discovering these.

## Repo locations

GrowthX product repos live under `~/openclaw-projects/<repo>/`. NEVER under `~/Projects/` for GrowthX repos. The canonical product → repo mapping for bug routing lives in `~/Projects/junior/support/repo-routing.yaml` — read once at intake to confirm the routed repos for the bug's product.

For the typical `growthx` product:
- Frontend: `~/openclaw-projects/growthx/gx-client-next` (Next.js)
- Backend: `~/openclaw-projects/growthx/gx-backend` (Node)

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
├── reproduction.md     # reproducer output (after !reproducer)
├── scoping.md          # scoper output (after !scoper)
├── review.md           # reviewer output (after !reviewer)
├── validation.md       # validator output (after !validator)
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
