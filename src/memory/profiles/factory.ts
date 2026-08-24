import { ProfileStore } from "./store.ts";
import type { ProfileStoreOptions } from "./types.ts";
import { resolve } from "node:path";

/** Runtime profile data must not follow the process cwd. */
export const DEFAULT_MEMORY_PROFILE_ROOT = "data/profiles";

/** Resolve an operator override once into the absolute root shared by all callers. */
export function resolveMemoryProfileRoot(value = process.env.MEMORY_PROFILE_ROOT): string {
  return resolve(value?.trim() || DEFAULT_MEMORY_PROFILE_ROOT);
}

export function createProfileStore(opts: ProfileStoreOptions = {}): ProfileStore {
  return new ProfileStore({ ...opts, root: opts.root ?? resolveMemoryProfileRoot() });
}
