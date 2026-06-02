# Process Tree Cleanup

## Invariant

When Junior terminates, every process it spawned must terminate too, and any
captured provider session id must remain persisted so the next turn can resume.

This applies to:
- headless runner CLIs (`claude`, `opencode`, `codex app-server`)
- workflow runner turns
- managed dev servers
- wrapper commands that spawn grandchildren, such as shell scripts that launch
  `bun test`, `npm run dev`, or framework dev servers

Force-killing Junior with `SIGKILL` cannot run cleanup code. The invariant is
for normal termination paths: `SIGINT`, `SIGTERM`, `!cancel`, `!stop`, timeout,
driver switch, reset, and managed dev-server teardown.

## Design

Junior starts external CLIs with `detached: true`, which places the process in
its own process group. Cleanup signals the negative PID (`process.kill(-pid)`)
so the whole group receives the signal, not only the wrapper process.

The shared helper is `src/lifecycle/process-tree.ts`:
- `signalProcessTree(pid, signal)` sends one signal to the process group, with a
  direct-PID fallback for non-detached or test handles.
- `terminateProcessTree(pid, opts)` sends a graceful signal, waits, then sends
  `SIGKILL` if anything in the group is still alive.
- `isProcessTreeAlive(pid)` checks the process group first, then the direct PID.

Spawner-owned `kill()` methods are synchronous handles, so they call
`signalProcessTree`. Awaited teardown paths, like dev-server shutdown, call
`terminateProcessTree`.

## Resumability

Provider session ids are persisted as soon as an `init` event arrives, not only
when the runner completes. This matters because shutdown can interrupt a turn
after init but before normal completion.

On shutdown:
- `SessionManager.terminateActiveRuns()` removes handle ownership first, then
  sends `SIGINT`. Late runner completions are ignored by the existing stale
  handle guard, so they cannot overwrite the shutdown-preserved row.
- Top-level busy/draining sessions are marked `idle`, `pid = null`, and retain
  `sessionId` / `leadSessionId`.
- Busy persistent agent sessions are marked `idle`, `pid = null`, and retain
  their per-agent `sessionId`.
- `WorkflowExecutor.terminateActiveRuns()` interrupts active workflow handles;
  workflow run rows keep `providerSessionId` captured from init.

The next Slack message resumes through the provider-native mechanism
(`--resume` for Claude, `--session` for OpenCode) when the provider supports it.

## Verification

Regression coverage includes:
- a real detached wrapper process that starts a `sleep` child; cleanup kills the
  child, proving process-group signaling covers descendants
- shutdown preserving a top-level session id captured before completion
- shutdown terminating a busy persistent agent when the top-level session is idle
- workflow shutdown terminating active workflow runner handles while preserving
  `providerSessionId`
- dev-server kill and killAll paths using process-tree termination

