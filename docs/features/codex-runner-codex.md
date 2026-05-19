# Codex Runner — Codex Scope

Date: 2026-05-15

This is an independent implementation scope for replacing Junior's hard-coded
`claude -p` runner with Codex support. It uses
[`codex-runner.md`](codex-runner.md) as input, but does not treat its architecture
as fixed.

## Goal

Junior should be able to run Codex as the local coding agent behind the same
Slack/session experience it has today:

- thread continuity
- live status updates
- final Slack responses
- persistent per-agent sessions
- worktree safety
- Slack MCP/tool access where available
- deterministic process lifecycle and timeout behavior

The immediate goal is not to delete Claude support. The clean replacement path is
to introduce a runner boundary, make Claude one adapter, make Codex another
adapter, then switch the default provider once Codex has parity.

## Current Reality

The app is still Claude-shaped at the execution boundary:

- `src/claude/args.ts` builds `claude -p ... --output-format stream-json`.
- `src/claude/parser.ts` parses Claude stream-json.
- `src/claude/spawner.ts` owns process launch, cwd selection, env injection,
  MCP config forwarding, session id capture, and final response capture.
- `src/session/manager.ts` calls `spawnClaude()` directly and listens for Claude
  native event shapes.
- `src/slack/formatting.ts` formats Claude assistant content blocks.
- `src/lifecycle/timeout.ts` imports Claude spawn types.
- `src/slack/home.ts` emits `claude --resume <sessionId>` hints.
- `src/config.ts` only exposes `config.claude`.

There is no `src/runners/` abstraction today.

Important current behavior to preserve:

- `spawnClaude()` injects `JUNIOR_SPAWNED`, Slack channel/thread env vars,
  `JUNIOR_AGENT_NAME`, and optional agent identity env vars.
- Worktree-backed runs receive Junior's project `.mcp.json`; `session.cwd`
  utility runs intentionally skip that MCP config.
- `SessionManager` stores one native session id per top-level session and one per
  persistent agent session.
- First turns get the full Slack/workspace preamble; resumed turns get a smaller
  workspace block.

## Codex CLI Facts Verified Locally

Verified against `codex-cli 0.130.0`.

Fresh non-interactive run:

```sh
codex --ask-for-approval never --sandbox read-only --cd /path/to/repo \
  exec --json --skip-git-repo-check -m <model> "Reply exactly: OK"
```

Resume run:

```sh
codex --ask-for-approval never exec resume <thread_id> "next prompt"
```

JSONL event shape:

```json
{"type":"thread.started","thread_id":"019e29f4-7651-7673-8754-46600d48c139"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":13012,"cached_input_tokens":2432,"output_tokens":22,"reasoning_output_tokens":15}}
```

Command events:

```json
{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/path\n","exit_code":0,"status":"completed"}}
```

Critical flag details:

- `--ask-for-approval` is a top-level Codex flag. Put it before `exec`.
- `--sandbox` is accepted before `exec`; use explicit values, not `--full-auto`.
- `--full-auto` is not present in `codex exec --help` for 0.130.0.
- `--image` / `-i` attaches image files. Use this instead of only putting image
  paths into prompt text.
- `--ignore-user-config` exists, but using it means Junior must inject all Codex
  config it needs.
- `--ephemeral` disables session persistence. Do not use it for Slack thread
  sessions that need resume.
- `codex exec` can read stdin. The spawner should set stdin to ignored/closed so
  service stdin or hook output cannot contaminate the prompt.

## Architecture Decision

Add a provider-neutral runner contract and adapt native events at the edge.

Do not make Slack/session code understand Claude and Codex native schemas. That
will leak provider details everywhere and make the second provider brittle.

Recommended app-level event model:

```ts
export type RunnerProvider = "claude" | "codex";

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

Keep provider-native event types inside adapter modules and adapter tests.

## Session Shape

Add provider metadata beside the existing native id:

```ts
provider: "claude" | "codex";
sessionId: string | null;
```

For persistent agent sessions, add the same provider field:

```ts
agentSessions[name].provider
agentSessions[name].sessionId
```

Reasoning:

- Keeping a single native id field minimizes migration risk.
- The provider field makes resume hints and future migrations unambiguous.
- Mixing providers inside the same native conversation should be disallowed. A
  provider switch starts a new native session id unless explicitly migrated.

Migration default: existing sessions normalize to `provider: "claude"`.

## Codex Prompt Strategy

Claude has `--append-system-prompt`; Codex CLI does not expose an equivalent.

For v1:

- On first turn, prepend Junior's composed agent prompt to the user prompt in a
  clearly delimited block.
- On resumed turns, do not prepend the full agent prompt again.
- Continue injecting the workspace safety block on resumed turns, matching the
  current manager behavior.

Example wrapper:

```text
<junior-agent-instructions>
...
</junior-agent-instructions>

<user-request>
...
</user-request>
```

Do not generate or mutate `AGENTS.md` in target repos for v1. That is powerful,
but it creates cleanup and ownership questions. Use prompt composition first.

## Codex Spawner Requirements

`spawnCodex()` should mirror the operational responsibilities of
`spawnClaude()`:

- choose cwd as `session.cwd ?? session.worktreePath ?? targetRepoCwd ?? process.cwd()`
- create `session.cwd` if needed
- pass `--cd <cwd>` even when spawn cwd is also set
- set stdin to ignored/closed
- inject the same Junior/Slack env vars as Claude
- parse stdout JSONL incrementally
- capture `thread.started.thread_id` as `sessionId`
- use the last completed `agent_message` as the response candidate
- collect stderr for non-zero exit
- expose `kill()` and `pid`

Suggested fresh args:

```ts
[
  "--ask-for-approval", config.codex.askForApproval,
  "--sandbox", config.codex.sandbox,
  ...(config.codex.search ? ["--search"] : []),
  "exec",
  "--json",
  "--cd", cwd,
  ...(config.codex.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
  ...(config.codex.ignoreUserConfig ? ["--ignore-user-config"] : []),
  ...(model ? ["--model", model] : []),
  ...imageArgs,
  prompt,
]
```

Suggested resume args:

```ts
[
  "--ask-for-approval", config.codex.askForApproval,
  "--sandbox", config.codex.sandbox,
  ...(config.codex.search ? ["--search"] : []),
  "exec",
  "resume",
  "--json",
  ...(model ? ["--model", model] : []),
  ...imageArgs,
  session.sessionId,
  prompt,
]
```

Before implementation, verify whether `exec resume` accepts `--cd`; the current
help output does not list it for the resume subcommand. If not, rely on spawn cwd
for resumed turns.

## MCP Strategy

Claude consumes Junior's `.mcp.json` directly. Codex does not.

Do not rely on a developer's global `~/.codex/config.toml` for Junior runtime.
There are two viable approaches:

1. Generate a temporary `CODEX_HOME` per Junior process or per spawn, containing
   a Codex config with the needed MCP servers.
2. Use Codex `-c key=value` overrides if the MCP config schema is verified.

Preferred v1: generated `CODEX_HOME`.

Reasoning:

- It avoids mutating user global config.
- It makes service behavior reproducible.
- It can be tested by inspecting a generated config file.
- It does not depend on undocumented dotted `-c` keys for MCP server tables.

Minimum MCP parity target:

- Slack bot MCP HTTP server: `http://localhost:3456/mcp`
- Playwright MCP stdio server: `npx @playwright/mcp --headless`

Validation task:

- Run a Codex spawn in a test thread and confirm the model can see/call the
  Slack MCP tool. Record the actual Codex tool names; do not assume Claude's
  `mcp__slack-bot__*` naming.

## Slack Formatting

Slack should consume normalized events:

- `message` events update live status with assistant text.
- `tool` events update live status with provider-neutral tool labels.
- `init` events update stored native session id.
- `done` events are mostly for usage/logging.

Codex mapping:

- `item.completed` + `agent_message` -> `message`
- `item.started` + `command_execution` -> `tool` with name `Bash`, status
  `started`, input `{ command }`
- `item.completed` + `command_execution` -> `tool` with name `Bash`, status
  `completed`, input `{ command, exit_code }`
- `thread.started` -> `init`
- `turn.completed` -> `done`

Claude mapping:

- `system/init` -> `init`
- assistant text blocks -> `message`
- assistant `tool_use` blocks -> `tool`
- `result` -> `done` plus final response capture in the adapter

## Provider Selection

Start with global selection:

```env
RUNNER_PROVIDER=claude|codex
```

Then add thread-level selection:

```text
!provider claude
!provider codex
```

Thread-level switching rules:

- If a thread has no native session id, switch provider immediately.
- If a thread already has a native session id for a different provider, require
  `!reset all` or a new `!provider <name> --reset` command.
- Status/home output must show provider and correct resume hint.

Resume hints:

```text
claude --resume <sessionId>
codex exec resume <sessionId>
```

## Implementation Plan

### 1. Runner Contract

- Add `src/runners/types.ts`.
- Move `SpawnHandle` and `SpawnResult` out of Claude-native types.
- Update `lifecycle/timeout.ts`, `SessionManager`, and tests to use runner
  types.
- Keep runtime behavior Claude-only.

Exit criteria:

- Existing tests pass.
- No Slack/session code imports `src/claude/types.ts`.

### 2. Claude Adapter

- Keep existing Claude parser and args builder.
- Add a mapper from Claude stream events to normalized runner events.
- Make `spawnClaude()` return normalized events.
- Update Slack formatting to consume `RunnerEventTool` and
  `RunnerEventMessage`.

Exit criteria:

- Existing Claude behavior unchanged.
- Slack formatting tests cover normalized events.

### 3. Codex Parser and Args

- Add `src/codex/parser.ts`.
- Add `src/codex/args.ts`.
- Fixture-test plain response, command execution, malformed JSON, and split
  chunks.
- Unit-test fresh vs resume arg placement, especially top-level
  `--ask-for-approval`.

Exit criteria:

- Parser captures thread id, messages, command status, and usage.
- Args do not use `--ephemeral` for resumable sessions.

### 4. Codex Spawner

- Add `src/codex/spawner.ts`.
- Mirror Claude env injection and lifecycle.
- Set stdin closed/ignored.
- Capture stderr and non-zero exits.
- Add smoke test script or documented manual command.

Exit criteria:

- `RUNNER_PROVIDER=codex` can answer a Slack thread with a final message.
- Session id is persisted and a second message resumes the same Codex thread.

### 5. Config and Provider Selection

- Add `config.runner.provider`.
- Add `config.codex`.
- Add `provider` to `ThreadSession` and `AgentSession`, defaulting old sessions
  to Claude.
- Add `!provider` command and home/status display.

Exit criteria:

- A Claude thread and Codex thread can coexist.
- Provider switching cannot accidentally resume a Claude id with Codex or vice
  versa.

### 6. MCP and Attachments

- Generate deterministic Codex MCP config through `CODEX_HOME` or verified
  config overrides.
- Pass image files with `--image`.
- Keep prompt path fallback only as extra context.

Exit criteria:

- Codex can call Slack MCP from a Junior-spawned run.
- Slack image attachment workflow works with Codex.

## Tests to Add

- Codex parser fixtures: simple answer, command execution, unknown event, split
  JSON line.
- Codex args: fresh run, resume run, image args, model override, permission
  flags, cwd behavior.
- Session manager: provider persisted, provider mismatch blocked, resume id
  captured from normalized `init`.
- Slack formatting: normalized Bash/tool/message events.
- Home tab: provider-specific resume hints.

## Main Risks

- Codex MCP config is not Claude `.mcp.json`; deterministic setup is the largest
  parity gap.
- Prompt-injected "system" instructions are weaker than Claude's
  `--append-system-prompt`.
- Codex CLI flags can move; keep args tests small and fixture-driven.
- Running with inherited stdin can accidentally feed Codex unrelated input.
- Resuming Codex under a service user depends on that user's `$CODEX_HOME`
  permissions and session storage.

## Recommended First Patch

Do not start with `spawnCodex()`.

Start by extracting the runner contract and normalizing Claude events while
keeping Claude as the only provider. That reduces the blast radius and gives the
Codex adapter a stable target. Once Slack/session code no longer imports Claude
native event types, Codex is a contained adapter rather than an app-wide rewrite.
