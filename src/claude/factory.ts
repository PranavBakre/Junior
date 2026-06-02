import type { ClaudeDriver, DriverMode } from "./driver.ts";
import { HeadlessDriver, type SpawnClaudeFn } from "./headless-driver.ts";
import { TmuxDriver, type TmuxDriverOptions } from "./tmux-driver.ts";

export interface CreateDriversOptions {
  /** Test seam — inject a fake spawn fn into the headless driver. */
  spawnFn?: SpawnClaudeFn;
  /** Test seam — inject a fake tmux invoker / transcript root into the tmux driver. */
  tmux?: TmuxDriverOptions;
}

export type DriverMap = Record<DriverMode, ClaudeDriver>;

/**
 * One instance per driver mode lives for the lifetime of the bot; the
 * manager picks which one to call based on `session.driverMode`. Tmux can
 * be constructed unconditionally — its constructor does no IO and `tmux`
 * is only shelled out at first send.
 */
export function createDrivers(options: CreateDriversOptions = {}): DriverMap {
  return {
    headless: new HeadlessDriver(options.spawnFn),
    tmux: new TmuxDriver(options.tmux),
  };
}
