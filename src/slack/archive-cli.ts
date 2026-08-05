import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { importSlackArchive, type SlackArchiveImportStore } from "./archive-import.ts";
import { SlackArchiveStore } from "./archive-store.ts";

interface ImportCliOptions {
  zipPath: string;
  dbPath: string;
  apply: boolean;
  batchSize: number;
}

function usage(): never {
  console.error(
    "Usage: bun run src/slack/archive-cli.ts import [--zip <export.zip>] [--db <archive.db>] [--batch-size <n>] [--dry-run|--apply]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): ImportCliOptions {
  if (argv[0] !== "import") usage();
  let zipPath = process.env.SLACK_ARCHIVE_EXPORT_PATH?.trim() || "";
  let dbPath = process.env.SLACK_ARCHIVE_DB_PATH?.trim() || "data/slack-archive.db";
  let apply = false;
  let batchSize = 500;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--zip") zipPath = argv[++index] ?? usage();
    else if (arg === "--db") dbPath = argv[++index] ?? usage();
    else if (arg === "--batch-size") {
      const value = Number(argv[++index] ?? usage());
      if (!Number.isInteger(value) || value < 1 || value > 10_000) usage();
      batchSize = value;
    } else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else usage();
  }
  if (!zipPath) usage();
  return { zipPath: resolve(zipPath), dbPath: resolve(dbPath), apply, batchSize };
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(options.zipPath) || !statSync(options.zipPath).isFile()) {
  throw new Error(`Slack export ZIP not found: ${options.zipPath}`);
}

// Dry-run deliberately avoids opening/creating the archive database.
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
