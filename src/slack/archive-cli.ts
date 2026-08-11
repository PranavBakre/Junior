import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { embedSlackArchive } from "./archive-embed.ts";
import { buildSlackArchiveVectorIndex } from "./archive-index.ts";
import { importSlackArchive, type SlackArchiveImportStore } from "./archive-import.ts";
import { SlackArchiveStore } from "./archive-store.ts";

interface ImportCliOptions {
  command: "import";
  zipPath: string;
  dbPath: string;
  apply: boolean;
  batchSize: number;
}

interface EmbedCliOptions {
  command: "embed";
  dbPath: string;
  apply: boolean;
  batchSize: number;
}

interface IndexCliOptions {
  command: "index";
  dbPath: string;
  indexPath: string;
  apply: boolean;
  batchSize: number;
  dimensions: number;
}

type CliOptions = ImportCliOptions | EmbedCliOptions | IndexCliOptions;

function usage(): never {
  console.error([
    "Usage:",
    "  bun run src/slack/archive-cli.ts import [--zip <export.zip>] [--db <archive.db>] [--batch-size <n>] [--dry-run|--apply]",
    "  bun run src/slack/archive-cli.ts embed [--db <archive.db>] [--batch-size <n>] [--dry-run|--apply]",
    "  bun run src/slack/archive-cli.ts index [--db <archive.db>] [--index <archive.db.usearch>] [--dim <n>] [--batch-size <n>] [--dry-run|--apply]",
    "",
    "Both commands default to dry-run. Writes require an explicit --apply.",
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0];
  if (command !== "import" && command !== "embed" && command !== "index") usage();
  let zipPath = process.env.SLACK_ARCHIVE_EXPORT_PATH?.trim() || "";
  let dbPath = process.env.SLACK_ARCHIVE_DB_PATH?.trim() || "data/slack-archive.db";
  let apply = false;
  let batchSize = command === "import" ? 500 : command === "embed" ? 100 : 1_000;
  let dimensions = 640;
  let indexPath = "";
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--zip" && command === "import") zipPath = argv[++index] ?? usage();
    else if (arg === "--db") dbPath = argv[++index] ?? usage();
    else if (arg === "--index" && command === "index") indexPath = argv[++index] ?? usage();
    else if (arg === "--dim" && command === "index") {
      dimensions = Number(argv[++index] ?? usage());
      if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 10_000) usage();
    }
    else if (arg === "--batch-size") {
      const value = Number(argv[++index] ?? usage());
      if (!Number.isInteger(value) || value < 1 || value > 10_000) usage();
      batchSize = value;
    } else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else usage();
  }
  if (command === "import") {
    if (!zipPath) usage();
    return { command, zipPath: resolve(zipPath), dbPath: resolve(dbPath), apply, batchSize };
  }
  if (command === "index") {
    const resolvedDbPath = resolve(dbPath);
    return {
      command,
      dbPath: resolvedDbPath,
      indexPath: resolve(indexPath || `${resolvedDbPath}.usearch`),
      apply,
      batchSize,
      dimensions,
    };
  }
  return { command, dbPath: resolve(dbPath), apply, batchSize };
}

const options = parseArgs(process.argv.slice(2));
if (options.command === "import") await runImport(options);
else if (options.command === "embed") await runEmbed(options);
else await runIndex(options);

async function runImport(options: ImportCliOptions): Promise<void> {
  if (!existsSync(options.zipPath) || !statSync(options.zipPath).isFile()) {
    throw new Error(`Slack export ZIP not found: ${options.zipPath}`);
  }

  // Import dry-run deliberately avoids opening/creating the archive database.
  const noWriteStore = {} as SlackArchiveImportStore;
  const store = options.apply ? new SlackArchiveStore(options.dbPath) : null;
  try {
    const report = await importSlackArchive({
      zipPath: options.zipPath,
      store: store ?? noWriteStore,
      dryRun: !options.apply,
      batchSize: options.batchSize,
    });
    console.log(JSON.stringify({
      ...report,
      zipPath: options.zipPath,
      dbPath: options.apply ? options.dbPath : null,
    }, null, 2));
  } finally {
    store?.close();
  }
}

async function runEmbed(options: EmbedCliOptions): Promise<void> {
  if (!existsSync(options.dbPath) || !statSync(options.dbPath).isFile()) {
    throw new Error(`Slack archive database not found: ${options.dbPath}`);
  }
  const store = new SlackArchiveStore(options.dbPath, { readonly: !options.apply });
  try {
    const report = await embedSlackArchive({
      store,
      dryRun: !options.apply,
      batchSize: options.batchSize,
      onProgress: (progress) => console.error(JSON.stringify({ event: "progress", ...progress })),
    });
    console.log(JSON.stringify({ ...report, dbPath: options.dbPath }, null, 2));
  } finally {
    store.close();
  }
}

async function runIndex(options: IndexCliOptions): Promise<void> {
  if (!existsSync(options.dbPath) || !statSync(options.dbPath).isFile()) {
    throw new Error(`Slack archive database not found: ${options.dbPath}`);
  }
  const store = new SlackArchiveStore(options.dbPath, { readonly: true });
  try {
    const eligible = store.countEmbeddedMessages(options.dimensions);
    if (!options.apply) {
      console.log(JSON.stringify({
        dryRun: true,
        eligible,
        dimensions: options.dimensions,
        dbPath: options.dbPath,
        indexPath: options.indexPath,
      }, null, 2));
      return;
    }
    const report = buildSlackArchiveVectorIndex({
      store,
      indexPath: options.indexPath,
      dimensions: options.dimensions,
      batchSize: options.batchSize,
      onProgress: (indexed, total) => console.error(JSON.stringify({
        event: "index-progress",
        indexed,
        total,
      })),
    });
    console.log(JSON.stringify({ ...report, dbPath: options.dbPath }, null, 2));
  } finally {
    store.close();
  }
}
