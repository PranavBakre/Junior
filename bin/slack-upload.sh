#!/bin/bash
# Upload a file to the current Slack thread.
# Usage: slack-upload.sh <file-path> [comment]
# Requires env vars: SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_THREAD_TS

set -e

FILE_PATH="$1"
COMMENT="${2:-}"

if [ -z "$FILE_PATH" ]; then
  echo "Usage: slack-upload.sh <file-path> [comment]" >&2
  exit 1
fi

if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$SLACK_CHANNEL" ] || [ -z "$SLACK_THREAD_TS" ]; then
  echo "Error: SLACK_BOT_TOKEN, SLACK_CHANNEL, and SLACK_THREAD_TS must be set" >&2
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo "Error: File not found: $FILE_PATH" >&2
  exit 1
fi

FILENAME=$(basename "$FILE_PATH")

# Step 1: Get upload URL
UPLOAD_RESPONSE=$(curl -s -X POST "https://slack.com/api/files.getUploadURLExternal" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "filename=$FILENAME&length=$(wc -c < "$FILE_PATH" | tr -d ' ')")

OK=$(echo "$UPLOAD_RESPONSE" | jq -r '.ok')
if [ "$OK" != "true" ]; then
  echo "Error getting upload URL: $UPLOAD_RESPONSE" >&2
  exit 1
fi

UPLOAD_URL=$(echo "$UPLOAD_RESPONSE" | jq -r '.upload_url')
FILE_ID=$(echo "$UPLOAD_RESPONSE" | jq -r '.file_id')

# Step 2: Upload file content
curl -s -X POST "$UPLOAD_URL" \
  -F "file=@$FILE_PATH" > /dev/null

# Step 3: Complete upload and share to channel/thread
COMPLETE_RESPONSE=$(curl -s -X POST "https://slack.com/api/files.completeUploadExternal" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"files\": [{\"id\": \"$FILE_ID\", \"title\": \"$FILENAME\"}],
    \"channel_id\": \"$SLACK_CHANNEL\",
    \"thread_ts\": \"$SLACK_THREAD_TS\",
    \"initial_comment\": \"$COMMENT\"
  }")

OK=$(echo "$COMPLETE_RESPONSE" | jq -r '.ok')
if [ "$OK" = "true" ]; then
  echo "Uploaded $FILENAME to thread"
else
  echo "Error completing upload: $COMPLETE_RESPONSE" >&2
  exit 1
fi
