# Code Index: Slack Archive

| Symbol | File | Purpose |
|---|---|---|
| `SlackArchiveStore` | `src/slack/archive-store.ts` | Standalone SQLite schema, idempotent upserts, FTS/vector hybrid search, thread reads, conversations, checkpoints |
| archive types | `src/slack/archive-types.ts` | Canonical messages, files, filters, results, checkpoints |
| `canonicalizeLiveSlackMessage` | `src/slack/events.ts` | Normalizes live message/edit/delete events before routing guards |
| `importSlackArchive` | `src/slack/archive-import.ts` | Streams standard Slack export members without extracting the ZIP |
| `SlackArchiveSync` | `src/slack/archive-sync.ts` | Public/approved Slack API gap repair with history checkpoints and old-thread reply reconciliation |
| archive CLI | `src/slack/archive-cli.ts` | Dry-run-by-default export import command |
| `registerSlackArchiveTools` | `src/mcp/slack-archive-tools.ts` | Signed-turn `slack_archive_search` and `slack_archive_thread`, scoped per result to public/approved channels |
| runtime wiring | `src/index.ts` | Store lifecycle, MCP handle, live event capture |

The archive database is intentionally separate from `memory.db`; no archive
table participates in memory consolidation or automatic pre-recall.
