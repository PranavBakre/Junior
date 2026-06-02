# Security Posture

Junior is intentionally insecure as a networked product. It is a trusted-operator developer tool meant to run on a local workstation or a private server controlled by the operator, with access limited by host/network boundaries rather than by application-layer auth.

Do not expose Junior, its dashboard, or its MCP server to untrusted networks without adding authentication, authorization, request-origin checks, and a real deployment security review.

## 1. Loopback-only Dashboard
The [HTTP Dashboard](./features/http-dashboard.md) binds only to `127.0.0.1` by default.
- **No Remote Access**: It is not reachable from the internet without an explicit SSH tunnel.
- **No Auth by Design**: Because Junior assumes a trusted local operator, the dashboard does not include an authentication layer.
- **No CORS Opt-in**: The dashboard does not emit CORS headers, so arbitrary websites cannot read API responses from a browser. The current dashboard is read-only; it does not validate `Origin` or `Sec-Fetch-Site` as a CSRF defense.

## 2. Worktree Isolation
Target repositories are never edited in their original paths.
- **Data Plane Isolation**: Junior creates isolated git worktrees for each Slack thread.
- **No Shared State**: Edits in one thread cannot affect the main branch or other threads until explicitly pushed by the runner.

## 3. Provider-level Permissions
Junior uses the native permission models of its runners:
- **OpenCode**: Junior generates config per spawn through `OPENCODE_CONFIG_CONTENT`, including permissions, MCP entries, and constrained support subagents.
- **Claude Code**: Uses `--permission-mode bypassPermissions` for trusted developer use, or can be configured for restricted modes.

## 4. MCP Server Security
The in-process Slack MCP server is intended for locally spawned runner processes and requires a shared `MCP_PORT`. It does not currently bind explicitly to loopback, so treat it as local-network exposed unless the host firewall or deployment environment restricts the port.

## 5. Environment Variables
Sensitive tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) should be stored in a `.env` file that is never committed (included in `.gitignore`).
