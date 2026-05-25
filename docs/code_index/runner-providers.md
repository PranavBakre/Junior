# Code Index: Runner Providers

Provider boundary for Claude/OpenCode spawning. App code talks to normalized
runner events; provider adapters own CLI args, config, parsing, resume, cwd, env,
and MCP wiring.

## Code Index

### src/runners

| Symbol | File | Purpose |
|---|---|---|
| `spawnRunner(session, prompt, config, ...)` | `index.ts` | Selects Claude/OpenCode provider and dispatches to the adapter. |
| `buildOpenCodeMcpConfig(config)` | `index.ts` | Builds OpenCode MCP entries (`slack-bot`, `playwright` by default unless disabled). |
| `buildRunnerRuntime(options)` | `runtime.ts` | Shared cwd/env contract for provider adapters. |
| `resolveRunnerCwd(session, targetRepoCwd?)` | `runtime.ts` | Cwd priority: `session.cwd` → `worktreePath` → target repo → Junior root. |
| `needsProjectMcp(session, cwd)` | `runtime.ts` | Claude-only project-MCP policy for worktree-backed runs. OpenCode has its own generated-config policy. |

### src/opencode

| Symbol | File | Purpose |
|---|---|---|
| `spawnOpenCode(...)` | `spawner.ts` | Runs `opencode run --format json`, generates `OPENCODE_CONFIG_CONTENT`, parses events. |
| `buildOpenCodeArgs(...)` | `args.ts` | Builds fresh/resume CLI args using `--session`, `--dir`, `--agent build`, and attachments; keeps the prompt before `--file` flags so OpenCode does not parse prompt text as file paths. |
| `buildOpenCodeConfig(...)` | `config.ts` | Generates model, permissions, primary `agent.build`, MCP entries, and subagent entries. |
| `loadOpenCodeSupportSubagents()` | `support-agents.ts` | Exposes standalone stateless support prompts as generated OpenCode subagents. |
| `buildOpenCodeAgentPrompt(...)` | `prompt.ts` | Wraps Junior core + active-agent prompt in the OpenCode provider baseline. |
| `createOpenCodeStreamParser()` / `createOpenCodeEventMapper()` | `parser.ts` | Converts OpenCode JSON events into normalized runner events. |

## Current OpenCode Runtime Rules

- Runtime uses provider agent `build`; Junior's actual role is carried in the
  generated prompt and env (`JUNIOR_AGENT_NAME`).
- Slack MCP is included for every normal OpenCode run, including the initial
  lead run from Junior root. It is omitted only for explicit `session.cwd`
  utility runs.
- Generated subagents include only stateless support fetchers:
  `nr-research`, `sentry-fetch`, `vercel-status`. They are omitted for utility
  `session.cwd` runs and use a constrained read/search/MCP permission surface.
- Persistent workers (`reproducer`, `thinker`, `review`) are not generated as
  OpenCode Task subagents; they are Slack-dispatched persistent sessions.
- Future OpenCode SDK/server support should be added as a separate provider or
  driver. Its interrupt path should call OpenCode's `session.abort` API and then
  prompt the same session to continue, rather than sending Escape bytes or
  changing the current CLI adapter's stdin policy.
