// ProfileStore — the KEYED, human-inspectable derivation layer (memory v3 §6, §8).
//
// Profiles live at `<root>/<kind-folder>/<slug>.md`, one file per entity, fetched
// by a deterministic key derived from `entity_ref`. No scanning on the hot path;
// `fetchByEntityRef` is a single primary-key-style path read. `list` globs folders
// for operator inspection / consolidation.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { parseDocument, serializeDocument, type Frontmatter } from "./frontmatter.ts";
import type {
  Profile,
  ProfileBase,
  ProfileInput,
  ProfileKind,
  ProfileStoreOptions,
} from "./types.ts";

const DEFAULT_ROOT = "memory/profiles";

const KIND_FOLDER: Record<ProfileKind, string> = {
  person: "people",
  repo: "repos",
  situation: "situations",
};

interface FieldSpec {
  key: string;
  type: "scalar" | "array";
}

// Ordered to match the §6.1 field lists so the rendered file reads naturally.
const PROFILE_FIELDS: Record<ProfileKind, FieldSpec[]> = {
  person: [
    { key: "role", type: "scalar" },
    { key: "comms_style", type: "scalar" },
    { key: "values", type: "array" },
    { key: "triggers", type: "array" },
    { key: "praises", type: "array" },
    { key: "preferences", type: "array" },
    { key: "relationship_trajectory", type: "scalar" },
    { key: "sentiment_trend", type: "scalar" },
  ],
  repo: [
    { key: "conventions", type: "array" },
    { key: "gotchas", type: "array" },
    { key: "merge_flow", type: "scalar" },
    { key: "owners", type: "array" },
    { key: "stack", type: "scalar" },
    { key: "hot_paths", type: "array" },
  ],
  situation: [
    { key: "pattern", type: "scalar" },
    { key: "signals", type: "array" },
    { key: "recommended_action", type: "scalar" },
  ],
};

export class ProfileStore {
  private readonly root: string;
  private readonly now: () => Date;

  constructor(opts: ProfileStoreOptions = {}) {
    this.root = opts.root ?? DEFAULT_ROOT;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Create or overwrite the file for an entity_ref. Merges over any existing
   * file: kind-specific fields are overridden where provided, evidence is
   * unioned, the prose body is replaced when provided, and updated_at is bumped.
   */
  async upsertProfile(input: ProfileInput): Promise<Profile> {
    const existing = await this.fetchByEntityRef(input.entity_ref);
    const merged = mergeProfiles(existing, input, formatDate(this.now()));
    const path = this.pathFor(merged.entity_ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeProfile(merged), "utf8");
    return merged;
  }

  /** Keyed read of one file by convention path. Returns null if absent. No scan. */
  async fetchByEntityRef(entityRef: string): Promise<Profile | null> {
    const path = this.pathFor(entityRef);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    return profileFromDocument(text);
  }

  /** Glob the folder(s) and parse every profile — for operator inspection. */
  async list(kind?: ProfileKind): Promise<Profile[]> {
    const kinds: ProfileKind[] = kind ? [kind] : (Object.keys(KIND_FOLDER) as ProfileKind[]);
    const profiles: Profile[] = [];
    for (const k of kinds) {
      const folder = join(this.root, KIND_FOLDER[k]);
      if (!existsSync(folder)) continue;
      for (const entry of readdirSync(folder)) {
        if (!entry.endsWith(".md")) continue;
        const text = readFileSync(join(folder, entry), "utf8");
        profiles.push(profileFromDocument(text));
      }
    }
    return profiles;
  }

  /** Map an entity_ref (`<slug>:<kind>`) to its convention path. */
  private pathFor(entityRef: string): string {
    const idx = entityRef.lastIndexOf(":");
    if (idx <= 0 || idx === entityRef.length - 1) {
      throw new Error(`Invalid entity_ref (expected '<slug>:<kind>'): ${entityRef}`);
    }
    const slug = entityRef.slice(0, idx);
    const suffix = entityRef.slice(idx + 1) as ProfileKind;
    if (!(suffix in KIND_FOLDER)) {
      throw new Error(`Unknown entity kind '${suffix}' in entity_ref: ${entityRef}`);
    }
    if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
      throw new Error(`Unsafe slug in entity_ref: ${entityRef}`);
    }
    return join(this.root, KIND_FOLDER[suffix], `${slug}.md`);
  }
}

// ---------------------------------------------------------------------------
// Profile <-> document mapping
// ---------------------------------------------------------------------------

function serializeProfile(profile: Profile): string {
  const frontmatter: Frontmatter = {};
  frontmatter.kind = `profile/${profile.kind}`;
  frontmatter.entity_ref = profile.entity_ref;
  for (const spec of PROFILE_FIELDS[profile.kind]) {
    const value = (profile as unknown as Record<string, unknown>)[spec.key];
    if (value === undefined) continue;
    frontmatter[spec.key] = spec.type === "array" ? toStringArray(value) : String(value);
  }
  frontmatter.evidence = profile.evidence;
  frontmatter.updated_at = profile.updated_at;
  return serializeDocument(frontmatter, profile.body);
}

function profileFromDocument(text: string): Profile {
  const { frontmatter, body } = parseDocument(text);

  const rawKind = String(frontmatter.kind ?? "");
  const kind = (rawKind.startsWith("profile/") ? rawKind.slice("profile/".length) : rawKind) as ProfileKind;
  if (!(kind in KIND_FOLDER)) {
    throw new Error(`Unknown or missing profile kind: '${rawKind}'`);
  }

  const base: Record<string, unknown> = {
    kind,
    entity_ref: String(frontmatter.entity_ref ?? ""),
    evidence: toStringArray(frontmatter.evidence),
    updated_at: String(frontmatter.updated_at ?? ""),
    body,
  };

  for (const spec of PROFILE_FIELDS[kind]) {
    const value = frontmatter[spec.key];
    if (value === undefined) continue;
    base[spec.key] = spec.type === "array" ? toStringArray(value) : String(value);
  }

  return base as unknown as Profile;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergeProfiles(existing: Profile | null, input: ProfileInput, nowDate: string): Profile {
  const kind = input.kind;

  const result: Record<string, unknown> = existing
    ? { ...(existing as unknown as Record<string, unknown>) }
    : ({ kind, entity_ref: input.entity_ref, evidence: [], updated_at: "", body: "" } satisfies ProfileBase as unknown as Record<string, unknown>);

  result.kind = kind;
  result.entity_ref = input.entity_ref;

  const inputRecord = input as unknown as Record<string, unknown>;
  for (const spec of PROFILE_FIELDS[kind]) {
    const value = inputRecord[spec.key];
    if (value === undefined) continue;
    result[spec.key] = spec.type === "array" ? toStringArray(value) : String(value);
  }

  if (input.body !== undefined) result.body = input.body;

  const existingEvidence = existing?.evidence ?? [];
  const incomingEvidence = toStringArray(input.evidence);
  result.evidence = unionStrings(existingEvidence, incomingEvidence);

  // updated_at is always bumped on write.
  result.updated_at = nowDate;

  return result as unknown as Profile;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function unionStrings(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...a, ...b]) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
