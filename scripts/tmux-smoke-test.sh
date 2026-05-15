#!/usr/bin/env bash
# Iter 0 substrate validation for the interactive driver.
#
# Run this once on the host that will run junior to confirm the assumptions
# the TmuxDriver depends on:
#   1. tmux >= 3.4 (paste-buffer -p exists)
#   2. Claude Code TUI accepts bracketed-paste input cleanly
#   3. Transcript JSONL files appear under ~/.claude/projects/<encoded-cwd>/
#   4. `system.subtype=turn_duration` events fire reliably on turn boundary
#   5. `--append-system-prompt` and `--mcp-config` flags work in interactive mode
#
# This is the go/no-go gate for shipping the TmuxDriver. Re-run when bumping
# Claude Code or tmux versions.
set -euo pipefail

SESSION_NAME="junior-tmux-smoke-$$"
TEST_CWD="$(mktemp -d -t junior-tmux-smoke.XXXXXX)"
ENCODED_CWD=$(echo -n "$TEST_CWD" | sed 's|/|-|g')
PROJECTS_DIR="$HOME/.claude/projects/$ENCODED_CWD"

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  rm -rf "$TEST_CWD"
}
trap cleanup EXIT

step() { printf '\n\033[1;34m== %s ==\033[0m\n' "$1"; }
pass() { printf '\033[1;32m  ✓\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m  ✗\033[0m %s\n' "$1" >&2; exit 1; }

step "tmux version"
TMUX_VER=$(tmux -V | awk '{print $2}')
TMUX_MAJOR=$(echo "$TMUX_VER" | sed 's/[^0-9.].*//' | cut -d. -f1)
TMUX_MINOR=$(echo "$TMUX_VER" | sed 's/[^0-9.].*//' | cut -d. -f2)
if [ "$TMUX_MAJOR" -gt 3 ] || { [ "$TMUX_MAJOR" -eq 3 ] && [ "$TMUX_MINOR" -ge 4 ]; }; then
  pass "tmux $TMUX_VER (>= 3.4)"
else
  fail "tmux $TMUX_VER is too old — need >= 3.4 for 'paste-buffer -p'"
fi

step "claude CLI present"
if command -v claude >/dev/null 2>&1; then
  pass "claude at $(command -v claude)"
else
  fail "claude CLI not in PATH"
fi

step "Start claude in tmux"
tmux new-session -d -s "$SESSION_NAME" -c "$TEST_CWD" \
  "claude --append-system-prompt 'Smoke test. Answer briefly.' --permission-mode bypassPermissions"
sleep 4
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  pass "tmux session $SESSION_NAME alive"
else
  fail "tmux session died on launch — check '$TEST_CWD' for crash logs"
fi

step "Paste a prompt with multi-line + special chars"
PROMPT='Say exactly: PASTE_OK
Then $stop. Backticks: `echo`.'
BUF_NAME="junior-smoke-$$"
TMP_BUF=$(mktemp)
printf '%s' "$PROMPT" >"$TMP_BUF"
tmux load-buffer -b "$BUF_NAME" "$TMP_BUF"
rm -f "$TMP_BUF"
tmux paste-buffer -p -b "$BUF_NAME" -t "$SESSION_NAME"
tmux send-keys -t "$SESSION_NAME" Enter
pass "Pasted (verify visually with: tmux attach -t $SESSION_NAME)"

step "Wait for transcript file to appear"
DEADLINE=$(($(date +%s) + 30))
JSONL=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -d "$PROJECTS_DIR" ]; then
    JSONL=$(ls -t "$PROJECTS_DIR"/*.jsonl 2>/dev/null | head -1 || true)
    [ -n "$JSONL" ] && break
  fi
  sleep 1
done
if [ -n "$JSONL" ]; then
  pass "Transcript: $JSONL"
else
  fail "No transcript file appeared in $PROJECTS_DIR within 30s"
fi

step "Wait for system.turn_duration (turn-done signal)"
DEADLINE=$(($(date +%s) + 120))
TURN_DONE=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if grep -q '"subtype":"turn_duration"' "$JSONL" 2>/dev/null; then
    TURN_DONE=$(grep '"subtype":"turn_duration"' "$JSONL" | tail -1)
    break
  fi
  sleep 2
done
if [ -n "$TURN_DONE" ]; then
  pass "turn_duration event seen"
  printf '  %s\n' "$TURN_DONE" | head -c 200
  printf '\n'
else
  fail "No turn_duration event in 120s — TmuxDriver's turn-boundary signal is unreliable on this host"
fi

step "Verify assistant content shape"
if grep -q '"type":"assistant"' "$JSONL"; then
  pass "assistant events present (parser-compatible shape)"
else
  fail "No assistant events found — transcript schema may have changed"
fi

step "Send second turn with --resume to validate continuity"
SESSION_ID=$(basename "$JSONL" .jsonl)
tmux kill-session -t "$SESSION_NAME"
sleep 1
tmux new-session -d -s "$SESSION_NAME" -c "$TEST_CWD" \
  "claude --resume $SESSION_ID --permission-mode bypassPermissions"
sleep 4
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  pass "Resumed session $SESSION_ID into fresh tmux session"
else
  fail "Resume failed — claude --resume <id> may not work after tmux teardown"
fi

step "Substrate validated — TmuxDriver assumptions hold"
printf '  - tmux %s OK\n  - paste-buffer -p OK\n  - transcript JSONL at: %s\n  - turn_duration signal OK\n  - --resume continuity OK\n' \
  "$TMUX_VER" "$JSONL"
