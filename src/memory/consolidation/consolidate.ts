// Consolidation engine — the OFFLINE write path (memory v3 §7).
//
// Reads raw source records (evidence), asks the injected LLM for derivations,
// then PERSISTS them through the v3 gates: episodes -> profiles -> claims, with
// proximity-dedup on claims, then stamps the records consolidated so they are
// never reprocessed. The LLM and embedder are injected; there is no runner
// spawn here (that is the production adapter, a separate follow-up).

import type { EmbeddingProvider } from "../embedding/types.ts";
import type { ProfileStore } from "../profiles/store.ts";
import type { ProfileKind } from "../profiles/types.ts";
import type { MemoryStore } from "../store.ts";
import type { ClaimInput, MemorySourceRecord } from "../types.ts";
import { referencedSlackUserIds, type PeopleResolver } from "./identity.ts";
import { buildConsolidationPrompt } from "./prompt.ts";
import type {
  ClaimContextSample,
  ConsolidationContext,
  ConsolidationInvoke,
  ConsolidationReport,
} from "./types.ts";

/** Cosine at/above which two claims are treated as near-duplicates. */
export const DEFAULT_DEDUP_THRESHOLD = 0.92;

export interface ConsolidateSessionArgs {
  store: MemoryStore;
  profileStore: ProfileStore;
  embedder: EmbeddingProvider;
  invoke: ConsolidationInvoke;
  /** Scope to one thread's records. Omit to consolidate across all threads. */
  threadId?: string;
  /** Cap the records pulled in one pass. */
  limit?: number;
  /**
   * Pre-fetched evidence to consolidate. When provided, the engine uses this set
   * verbatim and SKIPS the internal `listUnconsolidatedSourceRecords` call (so the
   * sweep can hand it a bin-packed, multi-thread batch). When absent, the engine
   * fetches by `threadId`/`limit` as before. Provenance is keyed on source-record
   * ids, so an arbitrary multi-thread set still persists/stamps correctly.
   */
  records?: MemorySourceRecord[];
  /** Per-record body cap (chars) forwarded to the prompt builder. Default: no cap. */
  bodyCap?: number;
  /**
   * Resolve Slack user ids in the evidence to display names so the LLM can
   * attribute records/mentions to PEOPLE (and their profiles). Omit → the
   * prompt shows raw ids only.
   */
  resolvePeople?: PeopleResolver;
  /** Clock (epoch ms). Defaults to Date.now(). */
  now?: number;
  /** Cosine dedup threshold. Defaults to DEFAULT_DEDUP_THRESHOLD (0.92). */
  dedupThreshold?: number;
}

export async function consolidateSession(args: ConsolidateSessionArgs): Promise<ConsolidationReport> {
  const { store, profileStore, embedder, invoke } = args;
  const now = args.now ?? Date.now();
  const threshold = args.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;

  // a. Gather unconsolidated evidence — use the pre-fetched set when the caller
  //    (the bin-packing sweep) supplies one, else fetch by threadId/limit.
  const records =
    args.records ??
    (await store.listUnconsolidatedSourceRecords({
      threadId: args.threadId,
      limit: args.limit,
    }));

  // b. Nothing to do.
  if (records.length === 0) return { skipped: true };

  // c. Build context: existing profiles for referenced entities + nearby claims
  //    + resolved identities for the people the evidence references.
  const context = await buildContext(store, profileStore, records, args.resolvePeople);

  // d. Ask the LLM for derivations.
  const output = await invoke(buildConsolidationPrompt(records, context, args.bodyCap));

  const recordById = new Map(records.map((r) => [r.id, r]));

  // e. PERSIST through the gates, in order: episodes -> profiles -> claims.

  // --- episodes ---
  const appendedEpisodeIds: string[] = [];
  for (const draft of output.episodes ?? []) {
    const backing = recordById.get(draft.sourceRecordId);
    // Only promote episodes that cite a record we actually processed.
    if (!backing) continue;
    await store.appendEpisode({
      id: draft.sourceRecordId,
      actor: draft.actor ?? backing.actorId ?? null,
      subjects: draft.subjects,
      what: draft.what ?? backing.body,
      emotion: draft.emotion ?? null,
      intensity: draft.intensity ?? null,
      valence: draft.valence ?? null,
      trigger: draft.trigger ?? null,
      response: draft.response ?? null,
      salience: draft.salience ?? null,
      createdAt: backing.createdAt,
      // Backing source-record fields (INSERT OR IGNORE — the row already exists).
      sourceKind: backing.kind,
      channelId: backing.channelId,
      threadId: backing.threadId,
      slackTs: backing.slackTs,
      sourceUrl: backing.sourceUrl,
      actorId: backing.actorId,
      actorKind: backing.actorKind,
      agentName: backing.agentName,
      repoName: backing.repoName,
      metadata: backing.metadata,
    });
    appendedEpisodeIds.push(draft.sourceRecordId);
  }
  // The consolidation pass just read these episodes into a derivation: bump
  // last_used_at (this is the genuine consolidation reader, so it may bump).
  if (appendedEpisodeIds.length > 0) {
    await store.markEpisodesUsed(appendedEpisodeIds, now);
  }

  // --- profiles (keyed merge) ---
  let profilesUpserted = 0;
  for (const draft of output.profiles ?? []) {
    await profileStore.upsertProfile(draft);
    profilesUpserted += 1;
  }

  // --- claims (embed + proximity-dedup) ---
  const existingVectors = await store.exportClaimVectors();
  const acceptedBatch: Float32Array[] = [];
  let claimsWritten = 0;
  let claimsDeduped = 0;

  // A batch can club multiple threads. The LLM output carries no per-claim source
  // episode, so `appendedEpisodeIds[0]` would falsely backlink a claim to whatever
  // episode happened to be appended first — possibly from a DIFFERENT thread. When
  // the record set spans more than one thread we can't recover the true episode, so
  // attribute nothing rather than a wrong link. Single-thread → keep the link.
  const distinctThreads = new Set(records.map((r) => r.threadId ?? null)).size;
  const claimSourceEpisode = distinctThreads > 1 ? null : appendedEpisodeIds[0] ?? null;
  for (const draft of output.claims ?? []) {
    const text = draft.text?.trim();
    if (!text) continue;
    const [vector] = await embedder.embed([text], "document");

    // Dedup vs existing active claims AND vs survivors already accepted this batch.
    const nearExisting = existingVectors.some((c) => cosine(vector, c.vector) >= threshold);
    const nearBatch = acceptedBatch.some((v) => cosine(vector, v) >= threshold);
    if (nearExisting || nearBatch) {
      claimsDeduped += 1;
      continue;
    }

    const claim: ClaimInput = {
      id: `claim_${fnv1a(text)}`,
      kind: draft.kind,
      text,
      embedding: vector,
      embedModel: embedder.model,
      dim: embedder.dim,
      repo: draft.repo ?? null,
      tags: draft.tags,
      sourceEpisode: claimSourceEpisode,
      createdAt: now,
    };
    await store.upsertClaim(claim);
    acceptedBatch.push(vector);
    claimsWritten += 1;
  }

  // f. Mark all processed records consolidated — even when nothing was derived,
  //    they are consumed exactly once (the high bar means most add nothing).
  await store.markSourceRecordsConsolidated(
    records.map((r) => r.id),
    now,
  );

  // g. Report.
  return {
    skipped: false,
    recordsProcessed: records.length,
    episodes: appendedEpisodeIds.length,
    profiles: profilesUpserted,
    claimsWritten,
    claimsDeduped,
  };
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

/**
 * Cap on profiles shown to the LLM. Referenced-entity profiles are always
 * included; the rest of the corpus fills the remaining slots, most recently
 * updated first.
 */
export const PROFILE_CONTEXT_CAP = 20;

async function buildContext(
  store: MemoryStore,
  profileStore: ProfileStore,
  records: MemorySourceRecord[],
  resolvePeople?: PeopleResolver,
): Promise<ConsolidationContext> {
  // Existing profiles for entities referenced by the records (best-effort,
  // keyed fetch — never bumps last_used_at, this is an internal read).
  const refs = referencedEntityRefs(records);
  const profiles = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    try {
      const profile = await profileStore.fetchByEntityRef(ref, { recordUsage: false });
      if (profile && !seen.has(profile.entity_ref)) {
        profiles.push(profile);
        seen.add(profile.entity_ref);
      }
    } catch {
      // Malformed ref — skip; the prompt simply won't show that profile.
    }
  }

  // Ref extraction only catches literal `<slug>:<kind>` mentions and repo names —
  // plain Slack evidence never says "pranav:person", so on its own the model
  // never saw existing profiles and therefore never updated them. The corpus is
  // small and keyed, so show the rest too (most recently updated first, capped).
  const rest = (await profileStore.list())
    .filter((p) => !seen.has(p.entity_ref))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const profile of rest) {
    if (profiles.length >= PROFILE_CONTEXT_CAP) break;
    profiles.push(profile);
    seen.add(profile.entity_ref);
  }

  // A sample of nearby existing claims so the LLM avoids restating them.
  const claims: ClaimContextSample[] = (await store.exportClaimVectors())
    .slice(0, 50)
    .map((c) => ({ text: c.text, kind: c.kind, repo: c.repo, tags: c.tags }));

  // Resolve the Slack ids the evidence references to display names. Evidence
  // identifies people only as raw ids (`actor_id`, `<@U…>` mentions), so without
  // this the LLM cannot attribute anything to a person. Resolution failures
  // degrade to raw ids, never abort the batch.
  let people: ConsolidationContext["people"];
  if (resolvePeople) {
    try {
      const resolved = await resolvePeople(referencedSlackUserIds(records));
      people = [...resolved.entries()].map(([id, name]) => ({ id, name }));
    } catch {
      people = undefined;
    }
  }

  return { profiles, claims, people };
}

const ENTITY_REF_RE = /\b([a-z0-9][a-z0-9_-]*):(person|repo|situation)\b/gi;

/**
 * Best-effort extraction of `<slug>:<kind>` entity refs the records touch:
 * the repo column (→ `<repo>:repo`) plus any explicit refs in bodies/metadata.
 * Used only to pre-load profile context for the prompt — not authoritative.
 */
function referencedEntityRefs(records: MemorySourceRecord[]): string[] {
  const refs = new Set<string>();
  for (const r of records) {
    if (r.repoName) refs.add(`${slugify(r.repoName)}:repo`);
    const haystack = `${r.body} ${r.metadata ? JSON.stringify(r.metadata) : ""}`;
    for (const m of haystack.matchAll(ENTITY_REF_RE)) {
      const slug = slugify(m[1]);
      const kind = m[2].toLowerCase() as ProfileKind;
      if (slug) refs.add(`${slug}:${kind}`);
    }
  }
  return [...refs];
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Local cosine + hash (intentionally NOT the store's private helpers — keep the
// engine self-contained and independently testable).
// ---------------------------------------------------------------------------

/** Cosine similarity. Returns 0 for mismatched dims or a zero vector. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 64-bit FNV-1a hex — stable claim id from text, so identical text upserts in
 * place. 64-bit (not 32-bit) keeps the id space far above the expected corpus
 * so two distinct claim texts don't birthday-collide onto one id and silently
 * overwrite each other via upsert (review finding).
 */
function fnv1a(str: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i += 1) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}
