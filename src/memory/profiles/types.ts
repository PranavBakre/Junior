// Profile types for the KEYED, human-inspectable derivation layer (memory v3 §6.1).
//
// Profiles are reached by a deterministic key (`entity_ref` from context), stored
// as markdown files (frontmatter + prose sketch), and are NOT embedded and NOT in
// SQLite. They are the source of truth, git-trackable and hand-correctable.
//
// These types are intentionally local to src/memory/profiles/ — the shared
// src/memory/types.ts is owned by another concern and must not be touched here.

export type ProfileKind = "person" | "repo" | "situation";

/** Fields every profile carries, regardless of kind. */
export interface ProfileBase {
  kind: ProfileKind;
  /** Keyed lookup id, shaped `<slug>:<kind>` e.g. `pranav:person`, `gx-backend:repo`. */
  entity_ref: string;
  /** Episode ids this derivation was built from (provenance). */
  evidence: string[];
  /** ISO date (YYYY-MM-DD) of the last consolidation write. */
  updated_at: string;
  /**
   * Epoch-ms of the last GENUINE keyed recall (decay signal, §7.1). Null/absent
   * until first used. Bumped ONLY on `fetchByEntityRef(ref, { recordUsage: true })`
   * — plain inspection and the internal upsert read must NOT bump it, or the fade
   * signal self-pollutes. Distinct from `updated_at`, which tracks consolidation
   * writes, not reads.
   */
  last_used_at?: number | null;
  /** Free prose sketch (the body below the frontmatter). */
  body: string;
}

/** Person profile — §6.1. */
export interface PersonProfile extends ProfileBase {
  kind: "person";
  role?: string;
  comms_style?: string;
  values?: string[];
  triggers?: string[];
  praises?: string[];
  preferences?: string[];
  relationship_trajectory?: string;
  sentiment_trend?: string;
}

/** Repo profile — §6.1. Repos are first-class memory subjects. */
export interface RepoProfile extends ProfileBase {
  kind: "repo";
  conventions?: string[];
  gotchas?: string[];
  merge_flow?: string;
  owners?: string[];
  stack?: string;
  hot_paths?: string[];
}

/** Situation profile — §6.1. */
export interface SituationProfile extends ProfileBase {
  kind: "situation";
  pattern?: string;
  signals?: string[];
  recommended_action?: string;
}

export type Profile = PersonProfile | RepoProfile | SituationProfile;

/**
 * Upsert payload: a full profile minus the store-managed/optional fields.
 * `updated_at` is always (re)stamped by the store on write; `evidence` and
 * `body` default to a union/keep when omitted.
 */
type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type ProfileInput =
  | WithOptional<PersonProfile, "updated_at" | "evidence" | "body">
  | WithOptional<RepoProfile, "updated_at" | "evidence" | "body">
  | WithOptional<SituationProfile, "updated_at" | "evidence" | "body">;

export interface ProfileStoreOptions {
  /** Root directory for profile files. Defaults to `memory/profiles`. */
  root?: string;
  /** Injectable clock, used to stamp `updated_at` and `last_used_at`. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface ProfileFetchOptions {
  /**
   * When true, bump `last_used_at = now` on the fetched profile — the genuine
   * keyed-recall signal that lets profiles fade (§7.1). DEFAULTS TO FALSE so plain
   * inspection and the store's own internal read never pollute the fade signal;
   * production keyed recall passes true explicitly.
   */
  recordUsage?: boolean;
}
