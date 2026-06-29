// Prompt builder for the consolidation LLM (memory v3 §7).
//
// The prompt encodes the HIGH BAR explicitly — the same discipline the v2
// learnings hook enforces: the default, correct output is EMPTY. Only durable,
// reusable derivations earn a write; affect is reserved for genuinely notable
// moments; existing profiles are UPDATED rather than restated; each claim is a
// single atomic fact. The model is also shown what Junior already knows
// (existing profiles + a sample of nearby claims) so it merges instead of
// duplicating.

import type { MemorySourceRecord } from "../types.ts";
import type { ConsolidationContext } from "./types.ts";

const HIGH_BAR = `You are Junior's memory consolidator. You read raw source records from a work
session and decide what — if anything — durable should be remembered.

THE BAR IS HIGH. The default, correct answer is to emit NOTHING. Most sessions
add no lasting knowledge. Returning empty arrays is the common, expected case —
it is a success, not a failure. Do not invent derivations to look useful.

Emit a derivation ONLY when it is durable and reusable beyond this thread:

- episodes: ONE per genuinely notable, affect-bearing moment (a real conflict,
  praise, a sharp correction, broken trust). Mundane turns get NO episode. Set
  affect (emotion, intensity 0..1, valence -1..1, trigger, response, salience
  0..1, actor, subjects) only for those notable moments. Each episode MUST cite
  the sourceRecordId it derives from.
- profiles: UPDATE an existing profile in place (same entity_ref) when you have
  learned something new and stable about a person, repo, or situation. Do NOT
  restate what the shown profile already says. Do NOT create a profile for a
  one-off. entity_ref is "<slug>:person" | "<slug>:repo" | "<slug>:situation".
- claims: ONE ATOMIC fact/lesson per claim — never a paragraph bundling several.
  Skip anything already covered by the existing claims shown below.

Return strictly JSON matching the schema: { "episodes": [...], "profiles": [...],
"claims": [...] }. When in doubt, leave it out.`;

export function buildConsolidationPrompt(
  records: MemorySourceRecord[],
  context: ConsolidationContext,
  /**
   * Per-record body cap (chars). When set, each record body is truncated to this
   * many chars in the prompt with a `…[truncated]` marker — runner_output records
   * are long and rarely need full text for memory derivation. Unset → no cap.
   */
  bodyCap?: number,
): string {
  const recordLines = records
    .map((r) => {
      const who = r.actorId ?? r.agentName ?? r.actorKind ?? "unknown";
      const where = [r.threadId ? `thread=${r.threadId}` : null, r.repoName ? `repo=${r.repoName}` : null]
        .filter(Boolean)
        .join(" ");
      let body = r.body.replace(/\s+/g, " ").trim();
      if (bodyCap != null && body.length > bodyCap) {
        body = `${body.slice(0, bodyCap)}…[truncated]`;
      }
      return `- id=${r.id} from=${who} kind=${r.kind}${where ? ` ${where}` : ""}\n    ${body}`;
    })
    .join("\n");

  const profileLines = context.profiles.length
    ? context.profiles
        .map((p) => {
          const sketch = p.body.replace(/\s+/g, " ").trim().slice(0, 280);
          return `- ${p.entity_ref} (updated ${p.updated_at})\n    ${sketch}`;
        })
        .join("\n")
    : "(none on file for the entities in these records)";

  const claimLines = context.claims.length
    ? context.claims
        .map((c) => `- [${c.kind}${c.repo ? ` repo=${c.repo}` : ""}] ${c.text.replace(/\s+/g, " ").trim()}`)
        .join("\n")
    : "(no nearby existing claims)";

  return [
    HIGH_BAR,
    "",
    "## Source records (evidence)",
    "These records may span MULTIPLE independent sessions/threads (grouped by the",
    "`thread=` tag). Judge each thread's evidence on its own — do NOT conflate",
    "facts, affect, or people across threads just because they share this prompt.",
    "",
    recordLines || "(none)",
    "",
    "## Existing profiles (UPDATE these, do not restate)",
    profileLines,
    "",
    "## Existing claims nearby (do NOT duplicate these)",
    claimLines,
    "",
    "Now produce the JSON. Remember: empty is the expected default.",
  ].join("\n");
}
