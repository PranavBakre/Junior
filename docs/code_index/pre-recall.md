# Code Index: Pre-recall

Pre-recall injects operational memory into a turn's prompt before the runner
spawns. Retrieval fuses embedding and exact-token ranks. Deterministic relevance filtering is the
default hot path; bounded LLM synthesis is optional through
`PRE_RECALL_SYNTHESIS_ENABLED`.

## Sources

| Symbol | File | Purpose |
|---|---|---|
| `createPreRecall(config, overrides?)` | `src/memory/pre-recall.ts` | Factory returning the `PreRecallFn` closure. `overrides` are the two test seams: `runText` (synthesis subprocess) and `deps` (memory store). |
| `deriveRecallQueries` | `src/memory/pre-recall.ts` | Message → 1-2 retrieval queries. No model call; the second is a `"<repo> <agent>: <message>"` scoped variant. |
| `selectSynthesisCandidates` | `src/memory/pre-recall.ts` | The three caps: candidate count, per-claim truncation, total candidate-character ceiling (drops lowest-scoring). |
| `selectFallbackCandidates` | `src/memory/pre-recall.ts` | Default deterministic selector and synthesis-failure fallback: top-3 above either `FALLBACK_MIN_COSINE` (0.55) or `FALLBACK_MIN_LEXICAL` (0.75), sorted by fused score. |
| `maxCosine` | `src/memory/pre-recall.ts` | Best cosine in a shortlist, for telemetry. Not `shortlist[0].cosine` — that list is score-ordered. |
| `buildSynthesisPrompt` / `parseSynthesisResult` | `src/memory/pre-recall.ts` | Request wrapped in a **per-call nonce delimiter** (`<request-a3f9>`) and labelled untrusted — a fixed tag is bypassable by nesting (`</req</request>uest>`). `{"notes":[…],"used":[1,4]}` envelope. Parse failure — missing, non-array, or an array with nothing usable in it — returns `null` → fallback. Only an explicit `"notes": []` is a rejection. |
| `formatPreRecallBlock(notes, { verbatim })` | `src/memory/pre-recall.ts` | The `<pre-recall>` block prepended to the prompt. Labels provenance: fallback lines are corpus text, synthesized lines are a model summary. |
| `buildPreRecallClaudeArgs` | `src/memory/pre-recall.ts` | Locked-down `claude -p` args (no tools, no MCP, no hooks; prompt on stdin). |
| `runPreRecallExited` / `runPreRecallProcess` | `src/memory/pre-recall.ts` | Timeout + process-tree SIGINT/SIGKILL guard shared by the claude/opencode/codex runners. |
| `recallMemory({ recordUsage })` | `src/mcp/slack-server.ts` | Retrieval. Pre-recall passes `false`; the `memory_recall` MCP tool keeps the default `true`. Each claim carries fused `score`, raw `cosine`, `lexicalScore`, and expanded parent-source context when available. |
| `MemoryStore.markClaimsUsed(ids, now)` | `src/memory/store.ts`, `src/memory/sqlite.ts` | Deferred `last_used_at` bump for the claims that actually reached the prompt. |

## Flow

```
message ──► deriveRecallQueries (embed, no subprocess)
        ──► recallMemory × N   (recordUsage:false, limit 8, 2 procedure slots)
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

`SessionManager.runRunnerWithAgent` awaits `this.preRecall(rawMessage, { repo, agent })`
immediately before the runner spawns (`src/session/manager.ts`). The turn-progress
reaction that covers that wait is separate — see
[session-management](session-management.md). Compiled typed worker assignments
skip automatic pre-recall because Junior's handoff carries the selected
evidence. Junior/lead assignments recall only on their initial dispatch
(`retryCount === 0`); bounded settlement continuations reuse the
assignment/provider context.
