# Code Index: Pre-recall

Pre-recall injects operational memory into a turn's prompt before the runner
spawns. Retrieval is embedding-only; the one LLM call is synthesis over the
retrieved claims. Design: [pre-recall-synthesis](../features/pre-recall-synthesis.md).

## Sources

| Symbol | File | Purpose |
|---|---|---|
| `createPreRecall(config, overrides?)` | `src/memory/pre-recall.ts` | Factory returning the `PreRecallFn` closure. `overrides` are the two test seams: `runText` (synthesis subprocess) and `deps` (memory store). |
| `deriveRecallQueries` | `src/memory/pre-recall.ts` | Message → 1-2 retrieval queries. No model call; the second is a `"<repo> <agent>: <message>"` scoped variant. |
| `selectSynthesisCandidates` | `src/memory/pre-recall.ts` | The three caps: candidate count, per-claim truncation, total candidate-character ceiling (drops lowest-scoring). |
| `buildSynthesisPrompt` / `parseSynthesisResult` | `src/memory/pre-recall.ts` | Numbered candidate prompt; `{"notes":[…],"used":[1,4]}` envelope. Parse failure returns `null` → fallback. |
| `formatPreRecallBlock` | `src/memory/pre-recall.ts` | The `<pre-recall>` block prepended to the prompt. |
| `buildPreRecallClaudeArgs` | `src/memory/pre-recall.ts` | Locked-down `claude -p` args (no tools, no MCP, no hooks; prompt on stdin). |
| `runPreRecallExited` / `runPreRecallProcess` | `src/memory/pre-recall.ts` | Timeout + process-tree SIGINT/SIGKILL guard shared by the claude/opencode/codex runners. |
| `recallMemory({ recordUsage })` | `src/mcp/slack-server.ts` | Retrieval. Pre-recall passes `false`; the `memory_recall` MCP tool keeps the default `true`. |
| `MemoryStore.markClaimsUsed(ids, now)` | `src/memory/store.ts`, `src/memory/sqlite.ts` | Deferred `last_used_at` bump for the claims that actually reached the prompt. |

## Flow

```
message ──► deriveRecallQueries (embed, no subprocess)
        ──► recallMemory × N   (recordUsage:false, limit 8, repo|global)
        ──► dedupe by claim id ──► selectSynthesisCandidates (3 caps)
        ──► runText (claude|opencode|codex, PRE_RECALL_TIMEOUT_MS)
              ├─ parsed  ──► notes + contributing ids
              └─ fail    ──► top-3 raw claims          (never null)
        ──► markClaimsUsed(contributing ids)
        ──► <pre-recall> block
```

Returns `null` only when no candidate was recalled, when synthesis rejected
every candidate, or when the attempt threw. Every attempt emits one
`log.info("pre-recall", …)` with queries / candidates / claims / fallback / ms.

## Call site

`SessionManager.runRunnerWithAgent` awaits `this.preRecall(rawMessage, { repo, agent })`
immediately before the runner spawns (`src/session/manager.ts`). The turn-progress
reaction that covers that wait is separate — see
[session-management](session-management.md).
