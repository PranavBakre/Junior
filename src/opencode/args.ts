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

  for (const file of options.files ?? []) {
    args.push("--file", file);
  }

  args.push(options.prompt);

  return args;
}
