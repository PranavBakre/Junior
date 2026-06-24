#!/bin/bash
# Launch an interactive Claude session with the same MCP wiring Junior's
# spawner provides to claude -p processes.
#
# Use this to manually test MCP connectivity (Figma, Notion, Slack, Playwright,
# MongoDB) from an interactive Claude session outside Junior.
#
# MCP servers are toggled via env flags (all default to true):
#
#   CLAUDE_MCP_SLACK=true|false
#   CLAUDE_MCP_PLAYWRIGHT=true|false
#   CLAUDE_MCP_FIGMA=true|false
#   CLAUDE_MCP_NOTION=true|false
#   CLAUDE_MCP_MONGODB=true|false
#
# The generated config is written to a temp file and passed via --mcp-config.
#
# Requires: jq

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

parse_bool() {
  local name="$1" value="$2" default="$3"
  if [ -z "$value" ]; then
    echo "$default"
    return
  fi
  local normalized
  normalized=$(echo "$value" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  case "$normalized" in
    1|true|yes|on) echo "true"; return ;;
    0|false|no|off) echo "false"; return ;;
    *) echo "Error: Invalid $name: \"$value\" (expected true|false)" >&2; exit 1 ;;
  esac
}

SLACK=$(parse_bool "CLAUDE_MCP_SLACK" "${CLAUDE_MCP_SLACK:-}" true)
PLAYWRIGHT=$(parse_bool "CLAUDE_MCP_PLAYWRIGHT" "${CLAUDE_MCP_PLAYWRIGHT:-}" true)
FIGMA=$(parse_bool "CLAUDE_MCP_FIGMA" "${CLAUDE_MCP_FIGMA:-}" true)
NOTION=$(parse_bool "CLAUDE_MCP_NOTION" "${CLAUDE_MCP_NOTION:-}" true)
MONGODB=$(parse_bool "CLAUDE_MCP_MONGODB" "${CLAUDE_MCP_MONGODB:-}" true)

CONFIG='{"mcpServers":{}}'

if [ "$SLACK" = "true" ]; then
  CONFIG=$(echo "$CONFIG" | jq --arg url "http://localhost:3456/mcp" \
    '.mcpServers["slack-bot"] = {type: "http", url: $url}')
fi

if [ "$PLAYWRIGHT" = "true" ]; then
  WRAPPER="$PROJECT_ROOT/bin/junior-mcp-stdio-wrapper.js"
  CONFIG=$(echo "$CONFIG" | jq --arg cmd "$WRAPPER" \
    '.mcpServers.playwright = {command: $cmd, args: ["--", "npx", "@playwright/mcp", "--headless"]}')
fi

if [ "$FIGMA" = "true" ]; then
  CONFIG=$(echo "$CONFIG" | jq \
    '.mcpServers.figma = {type: "http", url: "https://mcp.figma.com/mcp"}')
fi

if [ "$NOTION" = "true" ]; then
  CONFIG=$(echo "$CONFIG" | jq \
    '.mcpServers.notion = {type: "http", url: "https://mcp.notion.com/mcp"}')
fi

if [ "$MONGODB" = "true" ]; then
  MONGO_URL="${MONGO_MCP_URL:-http://localhost:3456/mcp/mongodb}"
  CONFIG=$(echo "$CONFIG" | jq --arg url "$MONGO_URL" \
    '.mcpServers.mongodb = {type: "http", url: $url}')
fi

MCP_CONFIG=$(mktemp /tmp/claude-mcp-XXXXXX.json)
echo "$CONFIG" > "$MCP_CONFIG"
trap 'rm -f "$MCP_CONFIG"' EXIT

SETTING_SOURCES="project"
if [ "$FIGMA" = "true" ] || [ "$NOTION" = "true" ]; then
  SETTING_SOURCES="user,project"
fi

echo "MCP config: $MCP_CONFIG"
echo "$CONFIG" | jq .
echo "setting-sources: $SETTING_SOURCES"
echo ""

exec claude --mcp-config "$MCP_CONFIG" --setting-sources "$SETTING_SOURCES" "$@"
