const KNOWN_COMMANDS = new Set([
  "build",
  "frontend",
  "review",
  "architect",
  "cancel",
  "reset",
  "status",
  "repo",
  "branch",
  "quiet",
  "verbose",
  "normal",
  "help",
  "adhoc",
  "bugs",
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
