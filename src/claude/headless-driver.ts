import { spawnClaude as defaultSpawnClaude } from "./spawner.ts";
import type { ClaudeDriver, DriverMode, DriverSendInput } from "./driver.ts";
import type { SpawnHandle } from "../runners/types.ts";

export type SpawnClaudeFn = typeof defaultSpawnClaude;

/**
 * Wraps the existing `spawnClaude` (one short-lived `claude -p` per turn)
 * behind the ClaudeDriver interface. No behavior change — this is the path
 * the bot has used since day one.
 */
export class HeadlessDriver implements ClaudeDriver {
  readonly mode: DriverMode = "headless";
  private spawnFn: SpawnClaudeFn;

  constructor(spawnFn: SpawnClaudeFn = defaultSpawnClaude) {
    this.spawnFn = spawnFn;
  }

  send(input: DriverSendInput): SpawnHandle {
    return this.spawnFn(
      input.session,
      input.prompt,
      input.config,
      input.targetRepoCwd,
      input.botToken,
      input.agentIdentity,
    );
  }

  async interrupt(_threadId: string, _agentName: string): Promise<void> {
    // No-op. Headless turns ARE the process; killing happens via the
    // SpawnHandle the manager holds, not through the driver. The manager's
    // `!cancel` already walks `this.handles` to kill them — that path is
    // unchanged.
  }

  async close(_threadId: string, _agentName: string): Promise<void> {
    // No persistent state between turns; nothing to tear down.
  }

  async closeIfSessionId(
    _threadId: string,
    _agentName: string,
    _expectedSessionId: string,
  ): Promise<boolean> {
    return false;
  }
}
