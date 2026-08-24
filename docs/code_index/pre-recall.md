# Code Index: Pre-recall

Pre-recall injects durable guidance into a turn's prompt before the runner
spawns. It excludes contextual/untyped facts before top-k ranking. Retrieval
uses the best cosine across each lesson's retrieval projections and fuses
exact-token ranks only for queries containing an exact anchor. Deterministic relevance filtering is the
default hot path; bounded LLM synthesis is optional through
`PRE_RECALL_SYNTHESIS_ENABLED`.

## Sources

| Symbol | File | Purpose |
|---|---|---|
| `createPreRecall(config, overrides?)` | `src/memory/pre-recall.ts` | Factory returning the `PreRecallFn` closure. `overrides` are the two test seams: `runText` (synthesis subprocess) and `deps` (memory store). |
| `deriveRecallQueries` | `src/memory/pre-recall.ts` | Message → 1-2 retrieval queries. No model call; the second is a `"<repo> <agent>: <message>"` scoped variant. |
| `recallCandidates` | `src/memory/pre-recall.ts` | Guidance-only recall. Trusted caller tags use AND matching first; an empty scoped pool falls back to untagged guidance. |
| `selectSynthesisCandidates` | `src/memory/pre-recall.ts` | The three caps: candidate count, per-claim truncation, total candidate-character ceiling (drops lowest-scoring). |
| `selectFallbackCandidates` | `src/memory/pre-recall.ts` | Default deterministic selector and synthesis-failure fallback: top-3 above either `FALLBACK_MIN_COSINE` (0.55) or `FALLBACK_MIN_LEXICAL` (0.75), sorted by fused score. |
| `maxCosine` | `src/memory/pre-recall.ts` | Best cosine in a shortlist, for telemetry. Not `shortlist[0].cosine` — that list is score-ordered. |
| `buildSynthesisPrompt` / `parseSynthesisResult` | `src/memory/pre-recall.ts` | Request wrapped in a **per-call nonce delimiter** (`<request-a3f9>`) and labelled untrusted — a fixed tag is bypassable by nesting (`</req</request>uest>`). `{"notes":[…],"used":[1,4]}` envelope. Parse failure — missing, non-array, or an array with nothing usable in it — returns `null` → fallback. Only an explicit `"notes": []` is a rejection. |
| `formatPreRecallBlock(notes, { verbatim })` | `src/memory/pre-recall.ts` | The `<pre-recall>` block prepended to the prompt. Labels provenance: fallback lines are corpus text, synthesized lines are a model summary. |
| `buildPreRecallClaudeArgs` / `claudeRunText` / `openCodeRunText` / `codexRunText` | `src/memory/pre-recall.ts` | Locked-down provider launches (no tools/MCP/hooks where supported; prompts are stdin except OpenCode's CLI positional contract). Every provider receives `buildSterileRunnerEnv()`, which preserves ordinary CLI runtime/auth discovery while explicitly emptying Junior's Slack, GitHub (including reconciliation), Mixpanel, MCP-signing, and database credential keys so a child dotenv cannot rehydrate them. |
| `runPreRecallExited` / `runPreRecallProcess` / `readBoundedTextFile` | `src/memory/pre-recall.ts` | Timeout + process-tree SIGINT/SIGKILL guard shared by the claude/opencode/codex runners. Both provider pipes are drained immediately; stdout and stderr retain bounded tails, and oversized stdout/Codex output files are rejected. |
| `recallMemory({ recordUsage })` | `src/mcp/slack-server.ts` | Retrieval. Pre-recall passes `false`; the `memory_recall` MCP tool keeps the default `true`. Each claim carries fused `score`, raw `cosine`, `lexicalScore`, and expanded parent-source context when available. |
| `MemoryStore.markClaimsUsed(ids, now)` | `src/memory/store.ts`, `src/memory/sqlite.ts` | Deferred `last_used_at` bump for the claims that actually reached the prompt. |

## Flow

```
message ──► deriveRecallQueries (embed, no subprocess)
        ──► guidance SQL scope (lesson/preference/decision/typed procedure)
        ──► trusted tags AND-filter, then untagged fallback when empty
        ──► recallMemory × N   (recordUsage:false, conditional hybrid rank, limit 20)
        ──► dedupe by claim id ──► selectSynthesisCandidates (3 caps)
        ──► deterministic cosine-or-lexical floor (default)
          or runText when PRE_RECALL_SYNTHESIS_ENABLED=true
              ├─ parsed + cited ──► notes + contributing ids
              └─ fail/uncited   ──► top-3 raw claims clearing either floor
        ──► markClaimsUsed(contributing ids)
        ──► <pre-recall> block
```

Returns `null` when no candidate was recalled, when synthesis rejected every
candidate, when the fallback found nothing above either relevance floor, or when
the attempt threw. Notes that cite no candidate are treated as a failed call,
not emitted — model text attributable to no claim is the injection signature.
Every attempt emits one `log.info("pre-recall", …)` with queries / candidates /
top cosine / top score / claims / fallback / ms.

## Call site

`SessionManager.runRunnerWithAgent` awaits pre-recall with repo/agent context.
Specialist agent identity is supplied as a trusted tag; default/lead stays
untagged. Tags are routing scope, not relevance scores, and are never derived
from user message text. This runs immediately before the runner spawns
(`src/session/manager.ts`). The turn-progress
reaction that covers that wait is separate — see
[session-management](session-management.md). Compiled typed worker assignments
skip automatic pre-recall because Junior's handoff carries the selected
evidence. Junior/lead assignments recall only on their initial dispatch
(`retryCount === 0`); bounded settlement continuations reuse the
assignment/provider context.
