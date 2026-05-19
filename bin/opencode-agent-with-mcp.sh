#!/bin/bash
# Launch an OpenCode session with Junior agent prompts and MCP servers configured.
#
# This is the manual-dev companion to Junior's generated OpenCode runtime config:
# it composes a Junior agent prompt from .claude/agents/<agent>.md plus its
# declared common preamble, wires the same local MCP servers as
# opencode-with-mcp.sh, and injects everything through OPENCODE_CONFIG_CONTENT.
#
# Usage:
#   bin/opencode-agent-with-mcp.sh [agent] [opencode args...]
#   JUNIOR_AGENT=review bin/opencode-agent-with-mcp.sh [opencode args...]
#
# Examples:
#   bin/opencode-agent-with-mcp.sh build
#   bin/opencode-agent-with-mcp.sh review --debug
#
# MCP env flags mirror bin/opencode-with-mcp.sh / src/config.ts:
#   OPENCODE_MCP_ENABLED=true|false              default: true
#   OPENCODE_SLACK_MCP_ENABLED=true|false        default: true
#   OPENCODE_PLAYWRIGHT_MCP_ENABLED=true|false   default: true
#   OPENCODE_MIXPANEL_MCP_ENABLED=true|false     default: true (feature-metrics only)
#
# Requires: jq (https://jqlang.github.io/jq/)

set -e

usage() {
  cat <<'EOF'
Usage: bin/opencode-agent-with-mcp.sh [agent] [opencode args...]

Launch OpenCode with a generated Junior agent config and MCP wiring.

Arguments:
  agent                 Agent markdown stem under .claude/agents (default: build)
  opencode args...      Remaining args are passed to opencode unchanged

Environment:
  JUNIOR_AGENT                         Alternative way to choose the agent
  OPENCODE_MCP_ENABLED                 default: true
  OPENCODE_SLACK_MCP_ENABLED           default: true
  OPENCODE_PLAYWRIGHT_MCP_ENABLED      default: true
  OPENCODE_MIXPANEL_MCP_ENABLED        default: true (feature-metrics only)
  JUNIOR_OPENCODE_PERMISSION           default: allow
  OPENCODE_MODEL                       optional model override
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but was not found on PATH" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
AGENTS_DIR="$PROJECT_ROOT/.claude/agents"
COMMON_DIR="$AGENTS_DIR/common"
ORG_AGENTS_DIR="${JUNIOR_ORG_AGENTS_DIR:-$PROJECT_ROOT/agents-org}"
ORG_COMMON_DIR="$ORG_AGENTS_DIR/common"

AGENT_NAME="${JUNIOR_AGENT:-build}"
if [ $# -gt 0 ] && [[ "${1:-}" != -* ]]; then
  AGENT_NAME="$1"
  shift
fi

AGENT_FILE="$ORG_AGENTS_DIR/$AGENT_NAME.md"
if [ ! -f "$AGENT_FILE" ]; then
  AGENT_FILE="$AGENTS_DIR/$AGENT_NAME.md"
fi
if [ ! -f "$AGENT_FILE" ]; then
  echo "Error: agent not found: $AGENT_NAME" >&2
  echo "Searched:" >&2
  echo "  $ORG_AGENTS_DIR/$AGENT_NAME.md" >&2
  echo "  $AGENTS_DIR/$AGENT_NAME.md" >&2
  echo "Available agents:" >&2
  if [ -d "$ORG_AGENTS_DIR" ]; then
    for file in "$ORG_AGENTS_DIR"/*.md; do
      [ -f "$file" ] || continue
      basename "$file" .md >&2
    done
  fi
  for file in "$AGENTS_DIR"/*.md; do
    [ -f "$file" ] || continue
    basename "$file" .md >&2
  done
  exit 1
fi

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

strip_frontmatter() {
  awk '
    NR == 1 && $0 == "---" { in_fm = 1; next }
    in_fm && $0 == "---" { in_fm = 0; next }
    !in_fm { print }
  ' "$1"
}

frontmatter_value() {
  local key="$1" file="$2"
  awk -v key="$key" '
    NR == 1 && $0 == "---" { in_fm = 1; next }
    in_fm && $0 == "---" { exit }
    in_fm {
      split($0, parts, ":")
      if (parts[1] == key) {
        sub("^[^:]*:[[:space:]]*", "")
        print
        exit
      }
    }
  ' "$file"
}

append_file_if_exists() {
  local file="$1" output="$2"
  if [ -f "$file" ]; then
    cat "$file" >>"$output"
    printf '\n\n' >>"$output"
  else
    echo "Warning: common prompt not found: $file" >&2
  fi
}

append_file_if_exists_quiet() {
  local file="$1" output="$2"
  if [ -f "$file" ]; then
    cat "$file" >>"$output"
    printf '\n\n' >>"$output"
  fi
}

COMMON_PROFILE=$(frontmatter_value "common" "$AGENT_FILE")
if [ -z "$COMMON_PROFILE" ]; then
  COMMON_PROFILE="core"
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
PROMPT_FILE="$TMP_DIR/prompt.md"

cat >"$PROMPT_FILE" <<EOF
<opencode-provider-baseline>
You are Junior running inside OpenCode as a manual coding agent.

Use OpenCode's native tools to inspect files, search the workspace, edit code, and run verification commands. Read relevant code before changing it.

Respect the active workspace. Work in the current directory and explicit user-provided paths. Do not modify unrelated repositories, generated secrets, or user changes you did not make.

Keep changes scoped to the request and aligned with local patterns. Do not introduce broad refactors, dependencies, or abstractions unless needed to finish safely.

For code changes, run the most relevant typecheck, tests, linters, or targeted commands available. Report any command you could not run and the concrete blocker.

Priority order: explicit user instruction, provider/runtime safety, Junior active agent contract, Junior core rules, then reference context. If rules conflict, follow the higher-priority rule.
</opencode-provider-baseline>

<junior-active-agent>$AGENT_NAME</junior-active-agent>

EOF

# Match AgentRouter's common profile behavior: core is always first, then the
# agent-declared common stems in order with duplicate core removed.
append_file_if_exists "$COMMON_DIR/core.md" "$PROMPT_FILE"
IFS=',' read -ra COMMON_NAMES <<<"$COMMON_PROFILE"
for raw_name in "${COMMON_NAMES[@]}"; do
  name=$(echo "$raw_name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/\.md$//')
  [ -n "$name" ] || continue
  [ "$name" = "core" ] && continue
  append_file_if_exists "$COMMON_DIR/$name.md" "$PROMPT_FILE"
done

# Match AgentRouter's org overlay behavior: append matching org common files
# additively for the selected common profile.
if [ -d "$ORG_COMMON_DIR" ]; then
  IFS=',' read -ra ORG_COMMON_NAMES <<<"$COMMON_PROFILE"
  for raw_name in "${ORG_COMMON_NAMES[@]}"; do
    name=$(echo "$raw_name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/\.md$//')
    [ -n "$name" ] || continue
    append_file_if_exists_quiet "$ORG_COMMON_DIR/$name.md" "$PROMPT_FILE"
  done
fi

strip_frontmatter "$AGENT_FILE" >>"$PROMPT_FILE"

# --- Env defaults (mirror src/config.ts / opencode-with-mcp.sh) ---
MCP_ENABLED=$(parse_bool "OPENCODE_MCP_ENABLED" "${OPENCODE_MCP_ENABLED:-}" true)
SLACK_MCP=$(parse_bool "OPENCODE_SLACK_MCP_ENABLED" "${OPENCODE_SLACK_MCP_ENABLED:-}" true)
PLAYWRIGHT_MCP=$(parse_bool "OPENCODE_PLAYWRIGHT_MCP_ENABLED" "${OPENCODE_PLAYWRIGHT_MCP_ENABLED:-}" true)
MIXPANEL_MCP=$(parse_bool "OPENCODE_MIXPANEL_MCP_ENABLED" "${OPENCODE_MIXPANEL_MCP_ENABLED:-}" true)
PERMISSION="${JUNIOR_OPENCODE_PERMISSION:-allow}"

# --- Build config ---
CONFIG=$(jq -n \
  --rawfile prompt "$PROMPT_FILE" \
  --arg permission "$PERMISSION" \
  --arg desc "Junior manual agent: $AGENT_NAME" \
  '{
    "$schema": "https://opencode.ai/config.json",
    permission: $permission,
    agent: {
      build: {
        description: $desc,
        mode: "primary",
        permission: {"*": $permission},
        prompt: $prompt
      }
    }
  }')

if [ -n "${OPENCODE_MODEL:-}" ]; then
  CONFIG=$(echo "$CONFIG" | jq --arg model "$OPENCODE_MODEL" '.model = $model')
fi

if [ "$MCP_ENABLED" = "true" ]; then
  if [ "$SLACK_MCP" = "true" ]; then
    CONFIG=$(echo "$CONFIG" | jq --arg url "http://localhost:3456/mcp" \
      '.mcp["slack-bot"] = {type: "remote", url: $url, enabled: true}')
  fi

  if [ "$PLAYWRIGHT_MCP" = "true" ]; then
    CONFIG=$(echo "$CONFIG" | jq \
      '.mcp.playwright = {type: "local", command: ["npx", "@playwright/mcp", "--headless"], enabled: true}')
  fi

  if [ "$MIXPANEL_MCP" = "true" ] && [ "$AGENT_NAME" = "feature-metrics" ]; then
    CONFIG=$(echo "$CONFIG" | jq \
      '.mcp.mixpanel = {type: "local", command: ["npx", "-y", "mcp-remote", "https://mcp.mixpanel.com/mcp"], enabled: true}')
  fi
fi

export OPENCODE_CONFIG_CONTENT="$CONFIG"
export JUNIOR_AGENT_NAME="$AGENT_NAME"
unset OPENCODE_CONFIG

exec opencode "$@"
