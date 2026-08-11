const MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export type ReadOnlyCommand = readonly [string, ...string[]];

function bounded(value: string, name: string, max = 500): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\0\r\n]/.test(trimmed)) {
    throw new Error(`${name} must be a single non-empty value of at most ${max} characters`);
  }
  return trimmed;
}

function positionalIdentifier(value: string, name: string, max = 500): string {
  const identifier = bounded(value, name, max);
  if (
    identifier.startsWith("-") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(identifier)
  ) {
    throw new Error(`${name} is not a valid identifier or URL`);
  }
  return identifier;
}

export function newRelicNrqlCommand(input: {
  query: string;
  accountId?: number;
}): ReadOnlyCommand {
  const query = input.query.trim();
  if (!query || query.length > 10_000) {
    throw new Error("query must be between 1 and 10000 characters");
  }
  if (!/^(?:SELECT|FROM)\b/i.test(query)) {
    throw new Error("only read-only SELECT/FROM NRQL queries are allowed");
  }
  if (/\b(?:DELETE|DROP|INSERT|UPDATE|CREATE|ALTER)\b/i.test(query)) {
    throw new Error("mutating NRQL is not allowed");
  }
  if (
    input.accountId !== undefined &&
    (!Number.isSafeInteger(input.accountId) || input.accountId <= 0)
  ) {
    throw new Error("account_id must be a positive integer");
  }
  return [
    "newrelic",
    "nrql",
    "query",
    ...(input.accountId ? ["--accountId", String(input.accountId)] : []),
    "--query",
    query,
    "--format",
    "JSON",
  ];
}

export function sentryListCommand(input: {
  resource: "issues" | "events";
  organization: string;
  project?: string;
  query?: string;
  status?: "resolved" | "muted" | "unresolved";
  maxRows?: number;
}): ReadOnlyCommand {
  const maxRows = input.maxRows ?? 100;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 500) {
    throw new Error("max_rows must be an integer between 1 and 500");
  }
  const command: [string, ...string[]] = [
    "sentry-cli",
    input.resource,
    "list",
    "--org",
    bounded(input.organization, "organization", 200),
    "--max-rows",
    String(maxRows),
  ];
  if (input.project) {
    command.push("--project", bounded(input.project, "project", 200));
  }
  if (input.resource === "issues" && input.query) {
    command.push("--query", bounded(input.query, "query", 1_000));
  }
  if (input.resource === "issues" && input.status) {
    command.push("--status", input.status);
  }
  return command;
}

export function vercelReadCommand(input:
  | {
      operation: "list";
      project?: string;
      environment?: "production" | "preview" | "development";
      status?: string;
      limit?: number;
      scope?: string;
    }
  | {
      operation: "inspect";
      deployment: string;
      includeBuildLogs?: boolean;
      scope?: string;
    }
  | {
      operation: "logs";
      deployment?: string;
      project?: string;
      environment?: "production" | "preview";
      level?: "error" | "warning" | "info" | "fatal";
      since?: string;
      until?: string;
      query?: string;
      limit?: number;
      scope?: string;
    }
): ReadOnlyCommand {
  const scope = input.scope
    ? ["--scope", bounded(input.scope, "scope", 200)]
    : [];
  if (input.operation === "list") {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer between 1 and 100");
    }
    return [
      "vercel",
      "list",
      ...(input.project ? [positionalIdentifier(input.project, "project", 200)] : []),
      ...(input.environment ? ["--environment", input.environment] : []),
      ...(input.status ? ["--status", bounded(input.status, "status", 100)] : []),
      "--limit",
      String(limit),
      "--format",
      "json",
      "--non-interactive",
      ...scope,
    ];
  }
  if (input.operation === "inspect") {
    return [
      "vercel",
      "inspect",
      positionalIdentifier(input.deployment, "deployment", 500),
      "--format",
      "json",
      ...(input.includeBuildLogs ? ["--logs"] : []),
      "--non-interactive",
      ...scope,
    ];
  }
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  return [
    "vercel",
    "logs",
    ...(input.deployment
      ? [positionalIdentifier(input.deployment, "deployment", 500)]
      : []),
    ...(input.project ? ["--project", bounded(input.project, "project", 200)] : []),
    ...(input.environment ? ["--environment", input.environment] : []),
    ...(input.level ? ["--level", input.level] : []),
    ...(input.since ? ["--since", bounded(input.since, "since", 100)] : []),
    ...(input.until ? ["--until", bounded(input.until, "until", 100)] : []),
    ...(input.query ? ["--query", bounded(input.query, "query", 1_000)] : []),
    "--limit",
    String(limit),
    "--json",
    "--no-follow",
    "--non-interactive",
    ...scope,
  ];
}

export async function runReadOnlyCommand(
  command: ReadOnlyCommand,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ command: string; exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
    ]);
    const decode = (buffer: ArrayBuffer) =>
      new TextDecoder().decode(buffer.slice(0, MAX_OUTPUT_BYTES));
    return {
      command: command.slice(0, 3).join(" "),
      exitCode,
      stdout: decode(stdout),
      stderr: decode(stderr),
    };
  } finally {
    clearTimeout(timer);
  }
}
