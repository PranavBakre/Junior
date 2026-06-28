import { ProfileStore } from "./store.ts";
import type { ProfileStoreOptions } from "./types.ts";

export function createProfileStore(opts: ProfileStoreOptions = {}): ProfileStore {
  return new ProfileStore(opts);
}
