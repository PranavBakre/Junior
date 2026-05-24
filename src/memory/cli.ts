import { createMemoryStore } from "./factory.ts";
import type { MemoryRecallOptions, SearchableMemoryKind } from "./types.ts";

export async function runMemoryCli(argv: string[]): Promise<string> {
  const { command, options } = parseArgs(argv);
  const dbPath = stringOption(options, "db") ?? process.env.MEMORY_DB_PATH ?? "data/memory.db";
  const json = booleanOption(options, "json");
  const store = createMemoryStore(dbPath);
  try {
    if (command === "recall") {
      const recallOptions: MemoryRecallOptions = {
        query: stringOption(options, "query"),
        tags: listOption(options, "tags"),
        entities: listOption(options, "entities"),
        kinds: listOption(options, "kinds") as SearchableMemoryKind[] | undefined,
        limit: numberOption(options, "limit"),
        depth: numberOption(options, "depth"),
        includeInactive: booleanOption(options, "include-inactive"),
        includeInvalid: booleanOption(options, "include-invalid"),
      };
      const results = await store.recall(recallOptions);
      return json ? `${JSON.stringify({ results }, null, 2)}\n` : formatRecall(results);
    }

    if (command === "consolidate") {
      const result = await store.consolidate({
        archiveBeforeMs: numberOption(options, "archive-before-ms"),
        lowImportanceThreshold: numberOption(options, "low-importance-threshold"),
        repeatedCorrectionThreshold: numberOption(options, "repeated-correction-threshold"),
      });
      return json ? `${JSON.stringify(result, null, 2)}\n` : formatConsolidation(result);
    }

    return usage();
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  runMemoryCli(Bun.argv.slice(2))
    .then((output) => process.stdout.write(output))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

function parseArgs(argv: string[]): { command: string; options: Map<string, string | true> } {
  const [command = "help", ...rest] = argv;
  const options = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options.set(key, true);
      continue;
    }
    options.set(key, next);
    i += 1;
  }
  return { command, options };
}

function stringOption(options: Map<string, string | true>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function listOption(options: Map<string, string | true>, key: string): string[] | undefined {
  const value = stringOption(options, key);
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberOption(options: Map<string, string | true>, key: string): number | undefined {
  const value = stringOption(options, key);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function booleanOption(options: Map<string, string | true>, key: string): boolean | undefined {
  return options.has(key) ? true : undefined;
}

function formatRecall(results: Awaited<ReturnType<ReturnType<typeof createMemoryStore>["recall"]>>): string {
  if (results.length === 0) return "No memories found.\n";
  return results
    .map((result, index) => [
      `${index + 1}. ${result.title ?? result.id} (${result.kind}, score ${result.score.toFixed(2)})`,
      result.body,
      `Reasons: ${result.reasons.join("; ")}`,
      `Sources: ${result.sourceIds.join(", ") || "none"}`,
    ].join("\n"))
    .join("\n\n") + "\n";
}

function formatConsolidation(result: Awaited<ReturnType<ReturnType<typeof createMemoryStore>["consolidate"]>>): string {
  return [
    `Promoted memories: ${result.promotedMemoryIds.join(", ") || "none"}`,
    `Archived events: ${result.archivedEventIds.join(", ") || "none"}`,
    `Proposed rules: ${result.proposedRuleIds.join(", ") || "none"}`,
    `Decisions: ${result.decisions.length}`,
  ].join("\n") + "\n";
}

function usage(): string {
  return [
    "Usage:",
    "  bun run src/memory/cli.ts recall --query <text> [--tags a,b] [--entities x,y] [--limit n] [--json]",
    "  bun run src/memory/cli.ts consolidate [--json]",
  ].join("\n") + "\n";
}
