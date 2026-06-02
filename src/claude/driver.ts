import type { Config } from "../config.ts";
import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type { SpawnHandle } from "../runners/types.ts";

/**
 * Driver mode is a per-session choice (stored on `ThreadSession.driverMode`).
 * "headless" = today's short-lived `claude -p` process per turn — billed
 * against API credits under the new Anthropic terms. "tmux" = persistent
 * interactive TUI inside a detached tmux session — stays under the Max
 * subscription.
 */
export type DriverMode = "headless" | "tmux";

export interface DriverSendInput {
  session: ThreadSession;
  prompt: string;
  config: Config["claude"];
  targetRepoCwd?: string;
  botToken?: string;
  agentIdentity?: AgentIdentity;
  /**
   * Routing keys used by drivers that hold per-thread state (tmux session
   * names, transcript tails). The manager already has these; passing them
   * explicitly keeps drivers from having to re-derive from session shape.
   */
  threadId: string;
  agentName: string;
}

/**
 * One driver instance per mode lives for the lifetime of the bot. Drivers
 * own no Slack state — they only know how to (a) run a turn of Claude and
 * (b) clean up after themselves on interrupt / close / shutdown.
 */
export interface ClaudeDriver {
  readonly mode: DriverMode;

  /**
   * Run one turn. Returns the same `SpawnHandle` shape the manager already
   * consumes — `result` resolves when the turn ends (process exit for
   * headless, `system.turn_duration` event for tmux), `onEvent` fires per
   * RunnerEvent, `kill` halts the in-flight turn.
   */
  send(input: DriverSendInput): SpawnHandle;

  /**
   * Halt an in-flight turn without tearing down the underlying session.
   * Headless: equivalent to `kill()` on the spawn handle (the process is the
   * turn, so killing the process ends the turn).
   * Tmux: sends Escape into the TUI input; the persistent claude process
   * stays alive and the next `send()` starts a fresh turn.
   */
  interrupt(threadId: string, agentName: string): Promise<void>;

  /**
   * Tear down any per-(thread, agent) state this driver holds.
   * Headless: no-op (no persistent state between turns).
   * Tmux: `tmux kill-session` for the corresponding session name.
   */
  close(threadId: string, agentName: string): Promise<void>;
}
