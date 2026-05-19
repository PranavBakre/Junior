# Security Posture

Junior is designed as a developer tool running on a local workstation or a trusted private server.

## 1. Loopback-only Dashboard
The [HTTP Dashboard](./features/http-dashboard.md) binds only to `127.0.0.1` by default.
- **No Remote Access**: It is not reachable from the internet without an explicit SSH tunnel.
- **No Auth**: Because it is loopback-only, it does not include an authentication layer.
- **CSRF Protection**: The API is restricted to the same origin; external sites cannot trigger Junior actions via the dashboard.

## 2. Worktree Isolation
Target repositories are never edited in their original paths.
- **Data Plane Isolation**: Junior creates isolated git worktrees for each Slack thread.
- **No Shared State**: Edits in one thread cannot affect the main branch or other threads until explicitly pushed by the runner.

## 3. Provider-level Permissions
Junior uses the native permission models of its runners:
- **OpenCode**: Junior generates a restricted `opencode.json` config per spawn, explicitly allowing or denying tools (e.g., `bash` is often restricted for support agents).
- **Claude Code**: Uses `--permission-mode bypassPermissions` for trusted developer use, or can be configured for restricted modes.

## 4. MCP Server Security
The in-process Slack MCP server only exposes tools to the locally spawned runner processes. It requires a shared `MCP_PORT` that is not exposed externally.

## 5. Environment Variables
Sensitive tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) should be stored in a `.env` file that is never committed (included in `.gitignore`).
