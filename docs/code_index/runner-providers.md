# Code Index: Runner Providers

Provider boundary for Claude/OpenCode/Codex spawning. Codex app-server is the
default base provider; standalone `codex exec` is not supported as a Junior base
runner. App code talks to normalized runner events; provider adapters own CLI
args, config, parsing, resume, cwd, env, and MCP wiring.

## Code Index

### src/runners

| Symbol | File | Purpose |
|---|---|---|
| `spawnRunner(session, prompt, config, ...)` | `index.ts` | Selects `claude`, `opencode`, `opencode-sdk`, or `codex-app-server` and dispatches to the adapter. |
| `buildOpenCodeMcpConfig(config, session)` | `mcp-config.ts` | Builds per-session MCP entries; hosted Figma/Notion OAuth servers require the agent capability plus their provider feature flags. |
| `buildRunnerRuntime(options)` | `runtime.ts` | Shared cwd/env contract for provider adapters. |
| `resolveRunnerCwd(session, targetRepoCwd?)` | `runtime.ts` | Cwd priority: `session.cwd` → `worktreePath` → target repo → Junior root. |
| `needsProjectMcp(session, cwd)` | `runtime.ts` | Claude-only project-MCP policy for worktree-backed runs. OpenCode has its own generated-config policy. |

### src/opencode

| Symbol | File | Purpose |
|---|---|---|
| `spawnOpenCode(...)` | `spawner.ts` | Runs `opencode run --format json`, generates `OPENCODE_CONFIG_CONTENT`, parses events. |
| `buildOpenCodeArgs(...)` | `args.ts` | Builds fresh/resume CLI args using `--session`, `--dir`, `--agent build`, and attachments; keeps the prompt before `--file` flags so OpenCode does not parse prompt text as file paths. |
| `buildOpenCodeConfig(...)` | `config.ts` | Generates model, permissions, primary `agent.build`, MCP entries, and subagent entries. |
| `prepareSkillRuntime(...)` | `../skills/runtime.ts` | Creates an assignment-scoped OpenCode skill directory containing only the selected trusted skill. |
| `buildOpenCodeAgentPrompt(...)` | `prompt.ts` | Wraps Junior core + active-agent prompt in the OpenCode provider baseline. |
| `resolveOpenCodeModel(...)` | `model.ts` | Resolves session/config model to a valid `provider/model` OpenCode ref; runner-specific aliases (`gpt-5.6-sol`, `opus`, ...) fall back to the config default or null (omit `--model`). |
| `createOpenCodeStreamParser()` / `createOpenCodeEventMapper()` | `parser.ts` | Converts OpenCode JSON events into normalized runner events; captures native `{"type":"error"}` events on `mapper.error`. |

## Current OpenCode Runtime Rules

- Runtime uses provider agent `build`; Junior's actual role is carried in the
  generated prompt and env (`JUNIOR_AGENT_NAME`).
- Slack MCP is included for every normal OpenCode run, including the initial
  lead run from Junior root. It is omitted only for explicit `session.cwd`
  utility runs.
- Slack runtime denies OpenCode `task` and registers no provider-native
  subagents. Junior creates every worker through its durable assignment graph.
- A `skill_dispatch` assignment sets `OPENCODE_CONFIG_DIR` to a generated
  one-skill discovery root and instructs OpenCode to load it with the native
  `skill` tool. The skill body is not copied into the agent prompt.
- `opencode-sdk` is the separate OpenCode server/SDK provider. It uses the
  native session abort/attach path and is tested independently from the CLI
  adapter.

### Assignment-scoped skills

`src/skills/registry.ts` is the provider-neutral trust boundary. Dispatch
persists `skillRef` plus exact `capabilityRefs`; `SessionManager` rejects unknown
or widened envelopes, skips worktrees and resume continuity, and returns results
through pipeline artifacts/outcomes rather than a direct Slack response.

- Claude CLI receives a one-skill `.claude/skills` root through `--add-dir`.
- OpenCode CLI receives a one-skill config root through
  `OPENCODE_CONFIG_DIR` and loads it with the native skill tool.
- Codex app-server receives a structured `type: "skill"` turn input.

Provider MCP configuration is still compiled independently from the validated
assignment capabilities.

Hosted OAuth parity: Claude, OpenCode, and Codex all add Figma/Notion only when
`wantsMcp(session, name)` is true. OpenCode and Codex also honor their
provider-specific `*_FIGMA_MCP_ENABLED` / `*_NOTION_MCP_ENABLED` kill switches.
