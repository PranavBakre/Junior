# Slack Archive

## Purpose

Slack history is a source-backed context corpus, not learned memory. Junior
stores it in `data/slack-archive.db` and searches it only when an agent asks for
Slack evidence. It is never injected by pre-recall and never consolidated into
lessons, facts, profiles, or episodes.

This separation keeps two different retrieval jobs honest:

- Junior memory supplies durable guidance: lessons, preferences, decisions,
  and procedures selected from trusted context and hybrid-ranked.
- The Slack archive supplies attributable historical context: messages,
  participants, timestamps, files, and complete threads.

## Ingestion

Enable live capture with:

```dotenv
SLACK_ARCHIVE_ENABLED=true
SLACK_ARCHIVE_DB_PATH=data/slack-archive.db
# Optional additional non-public channels:
SLACK_ARCHIVE_APPROVED_CHANNEL_IDS=G0123456789,C0987654321
```

Every allowed Socket Mode `message` event is normalized and upserted before
Junior's response-routing guards run. Public channels are allowed by Slack's
`channel_type`; non-public channels require an exact configured ID. Within that
scope, top-level messages, inactive threads, bot posts, and file-only messages
are archived even when Junior does not answer. Edits replace the canonical
`(channel_id, ts)` row and deletions replace its body with a tombstone.

Import a standard Slack export without extracting it into the repository:

```bash
# Parse and report only; this is the default.
bun run slack:archive:import -- --zip /absolute/path/export.zip --dry-run

# Write idempotently in bounded batches.
bun run slack:archive:import -- --zip /absolute/path/export.zip --apply
```

`SLACK_ARCHIVE_EXPORT_PATH` can supply the default ZIP path. Imports read each
JSON member using `unzip -p`, resolve channel/user manifests, and leave raw JSON
and embeddings unset. Public channels are imported by default; private channels
and DMs require their exact ID in `SLACK_ARCHIVE_APPROVED_CHANNEL_IDS`, and
directories missing from the export manifests fail closed. Live observations
always win over a later import of the same message. Per-channel history
checkpoints stay in the top-level-message timestamp domain; `SlackArchiveSync`
also compares full root metadata with locally archived thread timestamps so it
can repair missed replies on roots older than the history checkpoint.

### Weekly maintenance

`workflows/slack-archive-maintenance.workflow.md` runs every Sunday at 03:17
Asia/Kolkata. Its explicit `nativeHandler: slack-archive-maintenance` binding
executes typed application code directly; it does not invoke an agent or model.
The native pass:

1. queries Slack's Conversations API for all public channels and explicitly
   approved non-public channels, joins visible public channels where needed,
   and closes gaps for messages Junior never saw;
2. resumes from per-channel checkpoints and repairs replies on older threads;
3. embeds only new or edited non-empty messages;
4. atomically rebuilds `data/slack-archive.db.usearch` only when vectors changed
   or the index is absent; and
5. records counts and index state in a workflow-run artifact.

The workflow uses `concurrency: skip`, so a slow pass cannot overlap the next
one. A failed index build leaves the previously published sidecar intact.
The bot token requires `channels:join` in addition to `channels:read` and
`channels:history`; after changing Slack OAuth scopes, reinstall the app so the
new token grant takes effect.

## Retrieval and security

`slack_archive_search` embeds the query and combines ANN semantic retrieval with
FTS lexical retrieval, plus optional channel, actor, actor-kind, and time
filters. Imports do not generate embeddings immediately; the weekly native
maintenance pass embeds pending rows and republishes the ANN sidecar.
`slack_archive_thread` reads one exact channel/thread in chronological order.

Both tools require a signed runner turn whose stored session channel is public
or explicitly approved. Every requested or returned archive channel is checked
independently against the same public-or-approved policy, including unfiltered
searches and exact thread reads. Public/private status is resolved through Slack
on the server; configured IDs provide the explicit exception. Bare MCP calls,
unknown sessions, caller-forged channel parameters, and unapproved non-public
channels are denied. Results are size-bounded, source-labelled, and wrapped as
untrusted third-party data.

This MCP policy is not filesystem isolation. Agents with unrestricted local
filesystem access can still read the SQLite file; use OS-level controls or an
off-box service when that boundary is required.
