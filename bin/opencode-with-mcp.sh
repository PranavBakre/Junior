#!/bin/bash
# Launch an OpenCode session with MCP servers configured for Junior's project.
#
# This mirrors the MCP wiring that Junior's runtime provides to spawned
# OpenCode processes, but for manual `opencode` use (e.g. running the
# build agent in the TUI while developing Junior itself).
#
# MCP servers are controlled by the same env flags as Junior's runtime
# (src/config.ts parseBooleanEnv), so behavior is consistent between
# manual and spawned runs:
#
#   OPENCODE_MCP_ENABLED=true|false              default: true
#   OPENCODE_SLACK_MCP_ENABLED=true|false         default: true
#   OPENCODE_PLAYWRIGHT_MCP_ENABLED=true|false    default: false
#
# Boolean parsing matches src/config.ts: 1/true/yes/on and 0/false/no/off
# (case-insensitive). Invalid values produce an error, matching the runtime.
#
# The generated config is passed via OPENCODE_CONFIG_CONTENT, which OpenCode
# merges with project opencode.json at the highest precedence layer. This
# avoids editing the project config file and keeps MCP gating under env-flag
# control — the same pattern Junior's spawner uses for sub-agent runs.
#
# OPENCODE_CONFIG is unset to prevent a stale user-level config from
# interfering with the inline content.
#
# Requires: jq (https://jqlang.github.io/jq/)

set -e

# --- Boolean parser (mirrors src/config.ts parseBooleanEnv) ---
# Accepts: 1, true, yes, on (truthy) and 0, false, no, off (falsy),
# case-insensitive. Empty/unset returns the default. Invalid values error.
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

# --- Env defaults (mirror src/config.ts) ---
MCP_ENABLED=$(parse_bool "OPENCODE_MCP_ENABLED" "${OPENCODE_MCP_ENABLED:-}" true)
SLACK_MCP=$(parse_bool "OPENCODE_SLACK_MCP_ENABLED" "${OPENCODE_SLACK_MCP_ENABLED:-}" true)
PLAYWRIGHT_MCP=$(parse_bool "OPENCODE_PLAYWRIGHT_MCP_ENABLED" "${OPENCODE_PLAYWRIGHT_MCP_ENABLED:-}" false)

# --- Build config ---
CONFIG='{}'

if [ "$MCP_ENABLED" = "true" ]; then
  if [ "$SLACK_MCP" = "true" ]; then
    CONFIG=$(echo "$CONFIG" | jq --arg url "http://localhost:3456/mcp" \
      '.mcp["slack-bot"] = {type: "remote", url: $url, enabled: true}')
  fi

  if [ "$PLAYWRIGHT_MCP" = "true" ]; then
    CONFIG=$(echo "$CONFIG" | jq \
      '.mcp.playwright = {type: "local", command: ["npx", "@playwright/mcp", "--headless"], enabled: true}')
  fi
fi

CONFIG=$(echo "$CONFIG" | jq '. + {"$schema": "https://opencode.ai/config.json", permission: "allow"}')

export OPENCODE_CONFIG_CONTENT="$CONFIG"
unset OPENCODE_CONFIG

exec opencode "$@"