// Slash-command tokens consumed by parseCommand. These tokens are stripped
// from the message text. Persistent agents (lead, reproducer, thinker, review)
// are NOT in this set — `!<persistent-agent>` directives flow through to the
// AgentDispatcher with the prefix intact. `review` was historically here for
// the standalone code-review workflow but is now a persistent agent; removed
// to keep one syntax → one semantic.
const KNOWN_COMMANDS = new Set([
  "build",
  "frontend",
  "architect",
  "cancel",
  "reset",
  "status",
  "repo",
  "branch",
  "agent",
  "quiet",
  "verbose",
  "normal",
  "help",
  "adhoc",
  "bugs",
  "mute",
  "unmute",
  // Attention-gate commands. Handled in SessionManager.gateAttention before
  // any routing: `aside` drops the message; `listen` wakes from auto-dormant.
  "aside",
  "listen",
]);

export interface ParsedCommand {
  command: string | null;
  text: string;
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
    return { command: null, text };
  }

  return { command: commandWord, text: remaining };
}
