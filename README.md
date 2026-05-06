# junior

Slack bot that acts as the control plane for Claude Code sessions. See [CLAUDE.md](./CLAUDE.md) for architecture, [docs/](./docs) for feature notes.

## Run

```sh
bun install
bun run dev
```

## Dashboard

A localhost-only HTTP dashboard for inspecting live state — threads, per-agent
sessions, dev-server queue depth, recent logs.

**Off by default.** Enable by setting `HTTP_DASHBOARD_PORT`:

```sh
HTTP_DASHBOARD_PORT=8787 bun run dev
# open http://127.0.0.1:8787
```

The server binds to `127.0.0.1` only — there is no auth. Do not put it
behind a reverse proxy without adding one.

### What it shows

- **Threads** — every `ThreadSession` with its status, target repo / base ref,
  and a nested list of every per-agent session (lead / reproducer / thinker /
  review / echo) with that agent's `sessionId`, status, and last activity.
- **Dev Servers** — for each repo with `devCommand` configured: holder thread,
  branch, idle-TTL countdown, queued waiters. Reads `DevServerManager.status()`
  and `DevServerQueue.readQueueDepth()` directly.
- **Health** — uptime, version, totals.

### Endpoints

| Path | Description |
| --- | --- |
| `GET /` | Static dashboard (`public/index.html`) |
| `GET /api/health` | Uptime + session/agent totals |
| `GET /api/sessions` | All threads with their agent sessions |
| `GET /api/sessions/:threadId` | Full session detail |
| `GET /api/dev-server` | Per-repo manager state + queue depth |
| `GET /api/logs?date=YYYY-MM-DD&tail=50&tag=&level=` | Tail of structured logs |
| `GET /api/memory` | List of `docs/**/*.md` |
| `GET /api/memory/<path>` | Read a doc file |

### Credit

Ported from [Friday](https://github.com/anmolm-growthx/Friday)'s `src/http/`.
Junior-specific extensions: `/api/dev-server` exposes `DevServerQueue` state,
and `/api/sessions` joins the `agent_sessions` table to surface per-agent state
on multi-agent threads. Friday's SSE chat routes are intentionally not ported.
