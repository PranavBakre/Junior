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

## Retrieval and security

`slack_archive_search` uses FTS lexical retrieval with optional channel, actor,
actor-kind, and time filters. The store also supports caller-supplied vectors
and reciprocal-rank fusion, but importing the full corpus does not generate
embeddings by default. `slack_archive_thread` reads one exact channel/thread in
chronological order.

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
