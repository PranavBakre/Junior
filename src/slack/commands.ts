// Slash-command tokens consumed by parseCommand. These tokens are stripped
// from the message text. Persistent agents (lead, reproducer, review)
// are NOT in this set — `!<persistent-agent>` directives flow through to the
// AgentDispatcher with the prefix intact. `review` was historically here for
// the standalone code-review workflow but is now a persistent agent; removed
// to keep one syntax → one semantic.
export const KNOWN_COMMANDS = new Set([
  "build",
  "frontend",
  "architect",
  "cancel",
  "clear",
  "reset",
  "status",
  "repo",
  "branch",
  "agent",
  "provider",
  "quiet",
  "verbose",
  "normal",
  "help",
  "workflow",
  "workflows",
  "adhoc",
  "bugs",
  "mute",
  "unmute",
  // Driver controls — tmux substrate
  "stop",
  "driver",
  // Attention-gate commands. Handled in SessionManager.gateAttention before
  // any routing: `aside` drops the message; `listen` wakes from auto-dormant.
  "aside",
  "listen",
]);

const ASIDE_PREFIX_RE = /^!aside(?:$|\s|[.,:;!?-]\s*)/i;

export interface ParsedCommand {
  command: string | null;
  text: string;
}

export function isAsideText(text: string): boolean {
  return ASIDE_PREFIX_RE.test(text.trim());
}

function stripAsidePrefix(text: string): string {
  return text.trim().replace(ASIDE_PREFIX_RE, "").trim();
}

export function parseCommand(text: string): ParsedCommand {
  if (!text.startsWith("!")) {
    return { command: null, text };
  }

  const spaceIndex = text.indexOf(" ");
  const commandWord =
    spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const remaining = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

  if (!KNOWN_COMMANDS.has(commandWord)) {
    if (isAsideText(text)) {
      return {
        command: "aside",
        text: stripAsidePrefix(text),
      };
    }
    return { command: null, text };
  }

  return { command: commandWord, text: remaining };
}
