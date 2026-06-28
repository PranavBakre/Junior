// Consolidation engine contracts (memory v3 §7).
//
// The consolidation pass is the OFFLINE write path: it reads raw source records
// (evidence) and emits DERIVATIONS — episodes (affect log), profiles (keyed,
// human-inspectable) and atomic claims (semantic, embedded). The LLM that
// produces those derivations and the embedding provider are INJECTED, so the
// engine stays pure and testable; the production runner adapter is a separate
// follow-up.

import type { ClaimKind } from "../types.ts";
import type { Profile, ProfileInput } from "../profiles/types.ts";

/**
 * One notable, affect-bearing turn the LLM chose to promote to the episode log
 * (§5). It derives from exactly one source record (`sourceRecordId`); the
 * episode row reuses that id so the affect sidecar links back to its evidence.
 * `what` defaults to the backing source record body when omitted. Every other
 * field is the affect tag — emitted ONLY for genuinely notable moments, never
 * by default.
 */
export interface EpisodeDraft {
  /** The source_record id this episode derives from (becomes the episode id). */
  sourceRecordId: string;
  /** The utterance/event, verbatim-ish. Falls back to the source record body. */
  what?: string;
  /** Who said/did it (entity ref, e.g. `pranav:person`). */
  actor?: string;
  /** Entities this episode is ABOUT (multi-subject). */
  subjects?: string[];
  emotion?: string;
  intensity?: number;
  valence?: number;
  trigger?: string;
  response?: string;
  salience?: number;
}

/**
 * A keyed profile derivation. Identical to the ProfileStore upsert payload —
 * the engine forwards it straight to `upsertProfile`, which dedups by
 * `entity_ref` (merge in place, never a parallel file).
 */
export type ProfileDraft = ProfileInput;

/** One atomic claim (§6.1). Embedding/dedup is the engine's job, not the LLM's. */
export interface ClaimDraft {
  kind: ClaimKind;
  /** ONE atomic claim — authoritative. */
  text: string;
  repo?: string;
  tags?: string[];
}

/**
 * The structured output the consolidation LLM must return. The DEFAULT is empty
 * arrays — most turns add nothing (the v2 high bar carries over). The
 * `consolidationOutputSchema` below constrains a production LLM to this shape.
 */
export interface ConsolidationOutput {
  episodes: EpisodeDraft[];
  profiles: ProfileDraft[];
  claims: ClaimDraft[];
}

/** The injected LLM contract: prompt in, structured derivations out. */
export type ConsolidationInvoke = (prompt: string) => Promise<ConsolidationOutput>;

/**
 * A trimmed view of an existing claim, passed into the prompt so the LLM can
 * avoid restating knowledge that already exists (the embedding-level dedup is a
 * backstop, not the first line of defense).
 */
export interface ClaimContextSample {
  text: string;
  kind: ClaimKind;
  repo?: string | null;
  tags?: string[];
}

/** Context handed to the prompt builder: what Junior already knows. */
export interface ConsolidationContext {
  /** Existing profiles for entities referenced by the records (update, don't restate). */
  profiles: Profile[];
  /** A sample of nearby existing claims (avoid near-duplicates). */
  claims: ClaimContextSample[];
}

/** Outcome of a consolidation pass. */
export type ConsolidationReport =
  | { skipped: true }
  | {
      skipped: false;
      /** How many raw source records this pass consumed. */
      recordsProcessed: number;
      /** Episodes appended to the raw affect log. */
      episodes: number;
      /** Profiles upserted (keyed merge). */
      profiles: number;
      /** Claims actually written after dedup. */
      claimsWritten: number;
      /** Claim drafts dropped as near-duplicates (existing or in-batch). */
      claimsDeduped: number;
    };

/**
 * JSON Schema for `ConsolidationOutput`. Exported so a production LLM call can
 * be constrained to this shape (structured output / tool schema). Kept as a
 * plain object literal — no schema-library dependency — and intentionally
 * permissive on the affect ranges (the prompt, not the schema, enforces the
 * high bar on WHEN to emit).
 */
export const consolidationOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["episodes", "profiles", "claims"],
  properties: {
    episodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceRecordId"],
        properties: {
          sourceRecordId: { type: "string" },
          what: { type: "string" },
          actor: { type: "string" },
          subjects: { type: "array", items: { type: "string" } },
          emotion: { type: "string" },
          intensity: { type: "number", minimum: 0, maximum: 1 },
          valence: { type: "number", minimum: -1, maximum: 1 },
          trigger: { type: "string" },
          response: { type: "string" },
          salience: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    profiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["kind", "entity_ref"],
        properties: {
          kind: { type: "string", enum: ["person", "repo", "situation"] },
          entity_ref: { type: "string", pattern: "^.+:(person|repo|situation)$" },
          evidence: { type: "array", items: { type: "string" } },
          body: { type: "string" },
        },
      },
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { type: "string", enum: ["lesson", "fact", "situation-claim"] },
          text: { type: "string" },
          repo: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;
