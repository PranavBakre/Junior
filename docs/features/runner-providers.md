# Runner Providers

Date: 2026-05-15

This supersedes a Codex-only replacement plan. The right architecture is a
provider boundary: Junior owns Slack/session/worktree behavior, and provider
adapters own each CLI's flags, native event stream, prompt mechanics, MCP config,
and resume semantics.

## Recommendation

Build the provider abstraction first, then add OpenCode as the first non-Claude
provider.

OpenCode is currently a better replacement candidate than Codex for Junior's
specific needs because it has:

- `opencode run` for one-turn headless execution
- `--format json` for parseable event streaming
- `--session <id>` for resume
- `--dir <path>` for worktree cwd
- `--file <path>` for attachments
- `--agent build` and config-level agent prompts
- native MCP config in `opencode.json`
- `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG` for deterministic generated
  runtime config
- `opencode serve` + `opencode run --attach` as a future optimization for MCP
  cold-start cost

Codex remains viable, but OpenCode gives a cleaner story for dynamic Junior
agent prompts.

## Why OpenCode First

System prompts are the load-bearing surface for Junior. Junior's value is not
just "run a coding CLI from Slack"; it is dynamic personas and workflows: build,
frontend, review, architect, lead, reproducer, thinker, support fetchers, and
repo-local overlays. Claude handles that with `--append-system-prompt`.

OpenCode has a credible provider-native replacement:

- generate config per spawn with `OPENCODE_CONFIG_CONTENT` or `OPENCODE_CONFIG`
- override the built-in `build` primary agent with `agent.build.prompt`
- run `opencode run --agent build`

Codex does not currently expose an equivalent system-prompt flag. Its realistic
v1 option is to prepend Junior's agent prompt to the first user prompt, which is
weaker: it pollutes the user turn, has lower salience than a provider/system
prompt, and forces Junior to reason carefully about resumed turns. The other
Codex fallback, generating `AGENTS.md` in worktrees, writes prompt artifacts into
target workspaces and creates cleanup/ownership questions.

Configuration ergonomics also favor OpenCode:

- OpenCode MCP is a native `mcp` config block; Codex needs config/TOML override
  work or a generated Codex home.
- OpenCode permissions are config-level and per-agent; Codex splits sandbox mode
  from approval policy and is sensitive to flag position.
- OpenCode headless resume is `opencode run --session <id>`, which fits
  Junior's existing "one process per Slack turn" shape directly.

Risk profile matters. The Codex CLI surface has moved quickly, and the
Codex-specific doc already caught flag drift. The first non-Claude adapter should
be the one with the stronger prompt surface and simpler generated config story.

## Provider Contract

App code should consume normalized runner events, never Claude/OpenCode/Codex
native event shapes.

```ts
export type RunnerProvider = "claude" | "opencode" | "codex";

export type RunnerEvent =
  | { type: "init"; provider: RunnerProvider; sessionId: string }
  | { type: "message"; provider: RunnerProvider; text: string }
  | {
      type: "tool";
      provider: RunnerProvider;
      name: string;
      input: Record<string, unknown>;
      status?: "started" | "completed";
    }
  | { type: "done"; provider: RunnerProvider; usage?: Record<string, unknown> };

export interface SpawnResult {
  provider: RunnerProvider;
  sessionId: string | null;
  response: string;
  events: RunnerEvent[];
  exitCode: number | null;
  error: string | null;
}
```

Provider-native parser fixtures belong inside the provider adapter tests.
Session manager, Slack formatting, home tab, and timeout code should only depend
on `RunnerEvent`, `SpawnHandle`, and `SpawnResult`.

The contract also includes operational behavior that is easy to miss if each
adapter re-discovers it independently:

- **cwd policy:** adapters choose cwd as
  `session.cwd ?? session.worktreePath ?? targetRepoCwd ?? process.cwd()`.
- **utility cwd carve-out:** when `session.cwd` is set, skip Junior's project
  MCP wiring. Current Claude behavior does this because utility commands need
  their own cloud integrations, not Junior's local Slack/Playwright MCP config.
- **worktree MCP policy:** worktree-backed target-repo runs get Junior's local
  MCP wiring unless the provider config explicitly disables it.
- **stdin policy:** spawned runners must ignore/close stdin so service stdin,
  shell heredocs, or hook text cannot contaminate the prompt.
- **env contract:** every adapter injects the same Junior/Slack env vars:
  `JUNIOR_SPAWNED`, `SLACK_CHANNEL`, `SLACK_THREAD_TS`,
  `JUNIOR_AGENT_NAME`, optional `JUNIOR_SLACK_USERNAME`,
  optional `JUNIOR_SLACK_ICON_EMOJI`, and optional `SLACK_BOT_TOKEN`.
- **identity contract:** missing `JUNIOR_AGENT_NAME` or identity env vars is a
  silent attribution bug for sub-agent Slack posts.

`CLAUDE.md` rule 9 should stay aligned with this runner MCP contract: Junior has
one project MCP config for worktree-backed target-repo runs, and adapters skip
that project MCP wiring for explicit `session.cwd` utility runs.

## Current Claude Mapping

Claude remains the default adapter during the migration.

| Junior need | Claude today |
|---|---|
| fresh run | `claude -p <prompt>` |
| JSON stream | `--output-format stream-json --verbose` |
| resume | `--resume <sessionId>` |
| dynamic agent prompt | `--append-system-prompt <prompt>` |
| model | `--model <model>` |
| permissions | `--permission-mode <mode>` |
| MCP | project `.mcp.json` via `--mcp-config`, skipped for `session.cwd` utility runs |
| final response | `result.result` or last assistant text |
| session id | `system/init.session_id` |

The Claude adapter maps:

- `system/init` -> `init`
- assistant text block -> `message`
- assistant `tool_use` block -> `tool`
- `result` -> final response candidate and `done`

## OpenCode Mapping

Verified locally with OpenCode `1.14.48`.

Fresh run:

```sh
opencode run --format json --dir <worktree> --agent build "<prompt>"
```

Resume:

```sh
opencode run --format json --dir <worktree> --session <sessionID> --agent build "<prompt>"
```

Observed JSON events:

```json
{"type":"step_start","sessionID":"ses_..."}
{"type":"text","sessionID":"ses_...","part":{"type":"text","text":"\n\nOK"}}
{"type":"step_finish","sessionID":"ses_...","part":{"tokens":{"input":50,"output":16}}}
```

OpenCode adapter should map:

- any first event with `sessionID` -> `init`
- `text` -> `message`
- `step_finish.part.tokens` -> `done.usage`
- `tool_use.part` -> `tool`, using `part.tool`, `part.state.status`, and
  `part.state.input`

**Status (2026-05-15):** init/message/tool/done are mapped. Tool fixtures have
been captured for the observed OpenCode `tool_use` shape and now emit
`RunnerEventTool` for Slack status updates. Unknown future event types still log
at INFO (`opencode-parser`) so operators can capture additional fixtures.

Do not guess the tool event schema from docs.

## OpenCode Prompt Strategy

This is the main reason to prefer OpenCode over Codex.

Issue [anomalyco/opencode#7101](https://github.com/anomalyco/opencode/issues/7101)
and PR [#7264](https://github.com/anomalyco/opencode/pull/7264) show that direct
custom system prompt directories were requested but the PR was closed unmerged.
The useful finding is in the discussion: OpenCode agent prompts can be
overridden from config and appear to replace the base/provider prompt for that
agent.

Local check:

```sh
OPENCODE_CONFIG_CONTENT='{"agent":{"junior":{"description":"Junior test","mode":"primary","prompt":"CUSTOM JUNIOR SYSTEM PROMPT"}}}' \
  opencode debug agent junior --pure
```

Resolved output included:

```json
"prompt": "CUSTOM JUNIOR SYSTEM PROMPT"
```

Recommended v1:

- Generate `OPENCODE_CONFIG_CONTENT` per spawn, or generate a temp config file
  and point `OPENCODE_CONFIG` at it.
- Override the built-in `build` primary agent with `agent.build.prompt`.
- Set `agent.build.prompt` to a complete prompt: OpenCode provider baseline,
  shared Junior core rules, and Junior's composed dynamic agent prompt.
- Run `opencode run --agent build ...`.
- Keep first-turn Slack/thread preamble behavior in Junior's prompt builder.
- On resumed turns, avoid re-injecting full Slack history unless OpenCode resume
  proves it does not preserve it.

This gets closer to Claude's `--append-system-prompt` than Codex does, while
staying out of OpenCode's experimental plugin hooks.

Audit result from 2026-05-16:

- Static `.opencode/agents/lead.md` resolves as `native: false`, `mode:
  subagent`, with its static prompt.
- Generated `OPENCODE_CONFIG_CONTENT` for the same agent name wins for
  `prompt`, `mode`, and `description`.
- Permissions merge as ordered rules, but generated rules affect the effective
  tool surface.
- Static `.opencode/agents/build.md` resolves as `native: true`, and generated
  `agent.build.prompt` also stays `native: true`.
- Custom generated agents such as `junior` resolve as `native: false`.

Therefore Junior runtime should treat generated `OPENCODE_CONFIG_CONTENT` as
the source of truth and use provider agent `build` unless a future OpenCode
release changes the native-agent behavior.

This does **not** mean Junior should run as a monolithic build agent. Provider
agent `build` is the native OpenCode surface that preserves tools/permissions;
Junior's generated prompt still owns orchestration. The main agent must keep the
ability to parallelize independent work through Task/sub-agents or persistent
Slack directives so smaller-context models do not try to hold every repo,
observability trace, review, and reproduction path in one turn.

Avoid for v1:

- `experimental.chat.system.transform` plugins. Powerful, but too unstable for
  Junior's core runner path.
- `OPENCODE_MODELS_PATH`. The issue discussion suggests it changes model config,
  not system prompts.
- `opencode --prompt`. That starts the default TUI/app path; Junior needs
  `opencode run --format json`.

## OpenCode Generated Config

Junior generates its own config per spawn and should not rely on a developer's
global OpenCode config for correctness.

Generate config with:

- `model` if thread/session selected one
- `agent.build.prompt`
- `agent.build.mode = "primary"`
- `agent.build.permission` as an object override mirroring top-level
  `permission` (for string top-level values, emit `{ "*": "allow" }`) so inline
  runtime config has an explicit effective permission surface
- Task/sub-agent permissions enabled for roles that need parallel fanout
- `permission`
- `mcp`

Sketch:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-5.1",
  "permission": "allow",
  "agent": {
    "build": {
      "description": "Junior Slack runner",
      "mode": "primary",
      "permission": { "*": "allow" },
      "prompt": "<OpenCode provider baseline>\n\n<Junior core>\n\n<composed Junior system prompt>"
    }
  },
  "mcp": {
    "slack-bot": {
      "type": "remote",
      "url": "http://localhost:3456/mcp",
      "enabled": true
    },
    "playwright": {
      "type": "local",
      "command": ["npx", "@playwright/mcp", "--headless"],
      "enabled": true
    }
  }
}
```

Prefer `OPENCODE_CONFIG_CONTENT` for small configs. Use temp files via
`OPENCODE_CONFIG` if config size, escaping, or auditability becomes awkward.

### Known limitation: global config still merges

OpenCode loads configuration from layered sources in order
`~/.config/opencode/opencode.json` (global) → `OPENCODE_CONFIG` → project
`opencode.json` → `.opencode/` → `OPENCODE_CONFIG_CONTENT` (managed last). The
merge is *not* a replacement: `OPENCODE_CONFIG_CONTENT` wins only for keys it
*sets*; every key it leaves unset is filled in from earlier layers if any of
them define it. Junior's adapter cannot fully suppress the developer's
`~/.config/opencode/opencode.json` because OpenCode exposes no
`--ignore-user-config`-equivalent today.

Practical consequences for operators running Junior alongside their own
OpenCode setup:

- A global `model` (or per-provider model) leaks in when Junior omits `model`
  from its generated config.
- Global `mcp.<name>` entries persist alongside Junior's. When Junior omits
  `mcp` entirely (utility runs with no worktree), those globals become the
  *only* MCPs the child sees.
- Junior includes the local Slack MCP by default for OpenCode worktree-backed
  runs and for normal Junior-root lead/default runs. The only carve-out is an
  explicit `session.cwd` utility run, where Junior intentionally omits its local
  MCP wiring so utility commands can rely on their own cloud integrations. This
  matters for bug intake: lead must call `register_worktree` before any target
  worktree exists. Playwright MCP is enabled by default for OpenCode parity with
  Claude's project `.mcp.json`; set `OPENCODE_PLAYWRIGHT_MCP_ENABLED=false` if a
  deployment needs to avoid `npx @playwright/mcp` cold-start cost.
- Global `agent.<other>` definitions coexist with Junior's `agent.build`,
  expanding the agent set available inside the spawn.
- A shell-set `OPENCODE_CONFIG=/path/to/file` is inherited via the child's
  environment and loads before `OPENCODE_CONFIG_CONTENT` with the same
  merge semantics.

Mitigations in code today:

- The OpenCode spawner unsets `OPENCODE_CONFIG` on the child process so a
  developer's shell override does not load.
- The generated config sets `model`, top-level `permission`, and
  `agent.build.permission` explicitly when Junior has a value. Agent permission
  is object-shaped because OpenCode does not accept the string shorthand at that
  layer. Missing keys are the merge surface.
- The generated config exposes Junior's standalone stateless support prompts
  (`nr-research`, `sentry-fetch`, `vercel-status`) as OpenCode `mode:
  "subagent"` entries so Task fan-out works when the child cwd is a target repo
  or Junior's root. These subagents use a constrained permission surface:
  read/search tools and MCP tools only. Utility `session.cwd` runs do not receive
  these support subagents. Persistent workers (`reproducer`, `thinker`,
  `review`) are intentionally not exposed as OpenCode Task subagents; they must
  remain Slack-dispatched persistent sessions with their own audit trail.

If full isolation is required for a deployment (production, shared service
accounts), run Junior with `HOME` / `XDG_CONFIG_HOME` pointed at an empty
directory so OpenCode's global-config lookup hits nothing. For typical
developer workstations the leakage is bounded by what the dev has in their
own `opencode.json` and is acceptable.

## Permission Model

OpenCode defaults are permissive for many actions, with some guards such as
external directories. Junior should be explicit.

Suggested modes:

- build/code agents: `permission: "allow"` plus worktree isolation
- review/read-only agents: deny `edit` and risky `bash`, allow read/search
- utility commands: narrow tools and deny code edits

Avoid `--dangerously-skip-permissions` unless Junior is already running inside a
separate external sandbox. Prefer config permissions because they are
inspectable, testable, and per-agent.

## Session Shape

Persist provider beside the native id.

```ts
provider: "claude" | "opencode" | "codex";
sessionId: string | null;
```

For persistent agent sessions:

```ts
agentSessions[name].provider
agentSessions[name].sessionId
```

Rules:

- Existing sessions normalize to `provider: "claude"`.
- A provider switch on a thread with an existing native id must reset or fork the
  provider session.
- Never resume a Claude session id with OpenCode, or an OpenCode session id with
  Codex.

## Provider Selection

Start with global config:

```env
RUNNER_PROVIDER=opencode|claude
```

Default when unset: `opencode`.

Then add a thread command:

```text
!provider claude
!provider opencode
```

`codex` stays in the internal `RunnerProvider` union as a planned provider, but
is rejected at config load and at `!provider codex` until the Codex adapter
lands.

Home/status output should show:

- provider
- native session id
- provider-specific interactive resume command

Interactive resume hints:

```text
claude --resume <id>
opencode --session <id>
codex exec resume <id>
```

## Implementation Plan

### 1. Extract Runner Types

- Add `src/runners/types.ts`.
- Move `SpawnHandle` and `SpawnResult` out of `src/claude/types.ts`.
- Update `lifecycle/timeout.ts`, `SessionManager`, and tests.
- Keep runtime Claude-only.

Exit criteria:

- Existing tests pass.
- App-level code does not import Claude-native stream event types.

### 2. Preserve Runner Operational Contract

- Centralize cwd resolution so providers share the same policy.
- Centralize env construction so all providers inject the same Junior/Slack env
  vars.
- Centralize the `session.cwd` MCP skip rule.
- Keep `CLAUDE.md` rule 9 aligned with the shared runner MCP contract before any
  provider-specific MCP work.

Exit criteria:

- Existing Claude behavior is unchanged.
- Tests cover env injection and the `session.cwd` MCP carve-out at the runner
  boundary.

### 3. Normalize Claude

- Keep existing Claude args/parser.
- Add a Claude-native -> `RunnerEvent` mapper.
- Update Slack formatting to consume normalized `message` and `tool` events.

Exit criteria:

- Slack behavior is unchanged.
- Claude parser tests still cover native stream-json.

### 4. Add OpenCode Parser and Args

- Add `src/opencode/parser.ts`.
- Add `src/opencode/args.ts`.
- Fixture-test simple text response and session id capture.
- Capture and test bash/edit/read/MCP tool fixtures before formatting tools.

Exit criteria:

- OpenCode simple response maps to `init`, `message`, `done`.
- Resume args use `--session`, not `--continue`.
- Cwd uses `--dir`.

### 5. Add OpenCode Spawner

- Add `src/opencode/spawner.ts`.
- Generate config through `OPENCODE_CONFIG_CONTENT` or temp `OPENCODE_CONFIG`.
- Use the centralized Junior/Slack env contract.
- Honor the centralized `session.cwd` MCP skip rule.
- Set stdin ignored/closed.
- Capture stderr and non-zero exits.

Exit criteria:

- `RUNNER_PROVIDER=opencode` can answer a Slack thread.
- Second Slack message resumes the same OpenCode `sessionID`.

### 6. Provider Selection and Session Migration

- Add `config.runner.provider`.
- Add `config.opencode`.
- Add `provider` to `ThreadSession` and `AgentSession`.
- Add `!provider`.
- Update home tab/status.

Exit criteria:

- Claude and OpenCode sessions can coexist.
- Provider mismatch is blocked or requires reset.

### 7. Codex Later

After OpenCode is working, add Codex as another provider using the same runner
contract. Its adapter remains useful for environments where Codex CLI/auth is
preferred, but it should not drive the initial abstraction.

## Test Matrix

- Claude still passes all existing tests after normalization.
- OpenCode parser: text, split JSON, unknown event, malformed line, usage.
- OpenCode args: fresh, resume, model, agent, file attachments, cwd.
- OpenCode config generation: agent prompt, permissions, MCP entries.
- Runner contract: env injection, cwd resolution, `session.cwd` MCP skip.
- Session manager: provider persisted, provider mismatch blocked, reset clears
  provider session id.
- Slack formatting: normalized tool/message statuses.
- Home tab: provider-specific resume hints.

## Updated Position

Do not build "Codex runner" as the next step. Build "runner providers."

The first production replacement candidate should be OpenCode because its
headless JSON mode, sessions, generated config, MCP config, and custom primary
agent prompt line up better with Junior's current Claude surface. Codex can fit
the same contract later, but OpenCode should shape the non-Claude adapter first.
