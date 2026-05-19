export interface BuildOpenCodeArgsOptions {
  cwd: string;
  agentName: string;
  prompt: string;
  sessionId?: string | null;
  model?: string | null;
  files?: string[];
}

export function buildOpenCodeArgs(options: BuildOpenCodeArgsOptions): string[] {
  const args = [
    "run",
    "--format",
    "json",
    "--dir",
    options.cwd,
    "--agent",
    options.agentName,
  ];

  if (options.sessionId) {
    args.push("--session", options.sessionId);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  // OpenCode's --file is an array option. If it appears before the message,
  // yargs can greedily consume the prompt as another file path and echo the
  // full prompt in a "File not found" error. Keep the positional prompt before
  // file flags so attached images don't make prompt text parse as filenames.
  args.push(options.prompt);

  for (const file of options.files ?? []) {
    args.push("--file", file);
  }

  return args;
}
