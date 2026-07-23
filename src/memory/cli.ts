import { createMemoryStore } from "./factory.ts";
import type {
  ClaimKind,
  ClaimRecallResult,
  MemoryFactInput,
} from "./types.ts";
import {
  createSlackPeopleResolver,
  runConsolidationSweep,
  type ConsolidateV3Entry,
  type PeopleResolver,
} from "./consolidation/index.ts";
import { createRunnerInvoke } from "./consolidation/runner.ts";
import type { ConsolidationInvoke } from "./consolidation/types.ts";
import { createEmbeddingProvider } from "./embedding/factory.ts";
import type { EmbeddingProvider } from "./embedding/types.ts";
import { createProfileStore } from "./profiles/factory.ts";
import type { ProfileStore } from "./profiles/store.ts";

/**
 * Injectable dependencies for the offline consolidation engine (`consolidate-v3`).
 * Production callers pass nothing — the real local embedder + `claude -p` runner
 * are built lazily. Tests inject a hashing embedder + fake invoke + temp profile
 * store so they never load model weights or spawn a real CLI.
 */
export interface MemoryCliDeps {
  invoke?: ConsolidationInvoke;
  embedder?: EmbeddingProvider;
  profileStore?: ProfileStore;
  resolvePeople?: PeopleResolver;
}

/**
 * CLI identity resolution: a Slack-backed resolver when SLACK_BOT_TOKEN is in
 * the env (the CLI runs from Junior's project root, so it normally is), else
 * none — consolidation then shows raw Slack ids. Dynamic import keeps
 * @slack/web-api out of the module graph for token-less runs.
 */
async function defaultPeopleResolver(): Promise<PeopleResolver | undefined> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return undefined;
  const { WebClient } = await import("@slack/web-api");
  return createSlackPeopleResolver(new WebClient(token));
}

/** CLI default embedding provider: honor MEMORY_EMBED_PROVIDER, else local/harrier. */
function defaultEmbedProviderKind(): "local" | "hashing" {
  return process.env.MEMORY_EMBED_PROVIDER === "hashing" ? "hashing" : "local";
}

/**
 * Mirror a freshly-added lesson/fact into the semantic claim store so it is
 * recallable via memory_recall (v3) — the legacy lesson/fact tables are not
 * read by v3 recall or consolidation. Uses the same id as the legacy row (the
 * migration convention; memory_node.kind ends 'claim'). Best-effort: a lesson
 * is still captured in the legacy table even if embedding is unavailable.
 */
async function mirrorClaim(
  store: ReturnType<typeof createMemoryStore>,
  embedder: EmbeddingProvider,
  claim: { id: string; kind: "lesson" | "fact"; text: string; tags?: string[]; weight?: number; createdAt: number },
): Promise<boolean> {
  try {
    const [embedding] = await embedder.embed([claim.text], "document");
    await store.upsertClaim({
      id: claim.id,
      kind: claim.kind,
      text: claim.text,
      embedding,
      embedModel: embedder.model,
      dim: embedder.dim,
      tags: claim.tags,
      weight: claim.weight ?? 1.0,
      createdAt: claim.createdAt,
      active: true,
    });
    return true;
  } catch (err) {
    console.error(
      `[add] claim mirror skipped (embed failed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}


export async function runMemoryCli(argv: string[], deps: MemoryCliDeps = {}): Promise<string> {
  const { command, options } = parseArgs(argv);
  const dbPath = stringOption(options, "db") ?? process.env.MEMORY_DB_PATH ?? "data/memory.db";
  const json = booleanOption(options, "json");
  const store = createMemoryStore(dbPath);
  try {
    if (command === "consolidate-v3") {
      // Offline write path (memory v3 §7): read unconsolidated source records, ask
      // the runner LLM for derivations, persist through the gates. Manual trigger
      // only — no cron, and this does NOT touch the v2 `consolidate` path above.
      // The per-thread + unthreaded-sweep + isolation loop lives in the shared
      // `runConsolidationSweep` helper so the workflow and MCP tool run the same path.
      const profileStore = deps.profileStore ?? createProfileStore();
      const embedder = deps.embedder ?? createEmbeddingProvider(defaultEmbedProviderKind());
      const runner = stringOption(options, "runner");
      if (runner && runner !== "claude" && runner !== "opencode" && runner !== "codex") {
        throw new Error(`--runner must be one of: claude, opencode, codex. Got: ${runner}`);
      }
      const invoke =
        deps.invoke ??
        createRunnerInvoke({
          timeoutMs: numberOption(options, "timeout-ms"),
          runner: runner as "claude" | "opencode" | "codex" | undefined,
          model: stringOption(options, "model"),
          effort: stringOption(options, "effort"),
        });

      const resolvePeople = deps.resolvePeople ?? (await defaultPeopleResolver());

      const reports = await runConsolidationSweep({
        store,
        profileStore,
        embedder,
        invoke,
        resolvePeople,
        threadId: stringOption(options, "thread"),
        limit: numberOption(options, "limit"),
        maxBatchChars: numberOption(options, "max-batch-chars"),
        bodyCap: numberOption(options, "body-cap"),
        kinds: listOption(options, "kinds"),
      });

      return json
        ? `${JSON.stringify({ reports }, null, 2)}\n`
        : formatConsolidateV3(reports);
    }

    if (command === "add-lesson") {
      const id = stringOption(options, "id");
      const title = stringOption(options, "title");
      const body = stringOption(options, "body");
      if (!id) throw new Error("--id <lesson-id> is required");
      if (!title) throw new Error("--title <title> is required");
      if (!body) throw new Error("--body <body> is required");
      const sourceIds = listOption(options, "source-ids");
      const lessonCreatedAt = numberOption(options, "created-at") ?? Date.now();
      const lessonTags = listOption(options, "tags");
      await store.upsertLesson({
        id,
        title,
        body,
        appliesWhen: stringOption(options, "applies-when"),
        importance: numberOption(options, "importance"),
        createdAt: lessonCreatedAt,
        sourceIds,
        tags: lessonTags,
        entities: entityListOption(options, "entities"),
      });
      // Mirror into the semantic claim store so v3 memory_recall can find it.
      const lessonEmbedder = deps.embedder ?? createEmbeddingProvider(defaultEmbedProviderKind());
      const lessonClaimed = await mirrorClaim(store, lessonEmbedder, {
        id,
        kind: "lesson",
        text: `${title}\n${body}`,
        tags: lessonTags,
        weight: numberOption(options, "importance"),
        createdAt: lessonCreatedAt,
      });
      return json
        ? `${JSON.stringify({ upserted: id, kind: "lesson", claim: lessonClaimed }, null, 2)}\n`
        : `Lesson upserted: ${id}${lessonClaimed ? " [claim]" : ""}\n`;
    }

    if (command === "add-fact") {
      const id = stringOption(options, "id");
      const kind = stringOption(options, "kind") as MemoryFactInput["kind"] | undefined;
      const body = stringOption(options, "body");
      if (!id) throw new Error("--id <fact-id> is required");
      if (!kind) throw new Error("--kind <curated_fact|routing_memory|procedure> is required");
      if (!["curated_fact", "routing_memory", "procedure"].includes(kind)) {
        throw new Error(`--kind must be one of: curated_fact, routing_memory, procedure. Got: ${kind}`);
      }
      if (!body) throw new Error("--body <body> is required");
      const sourceIds = listOption(options, "source-ids");
      const factCreatedAt = numberOption(options, "created-at") ?? Date.now();
      const factTitle = stringOption(options, "title");
      const factTags = listOption(options, "tags");
      await store.upsertFact({
        id,
        kind,
        title: factTitle,
        body,
        confidence: numberOption(options, "confidence"),
        importance: numberOption(options, "importance"),
        createdAt: factCreatedAt,
        sourceIds,
        tags: factTags,
        entities: entityListOption(options, "entities"),
      });
      // Mirror into the semantic claim store so v3 memory_recall can find it.
      const factEmbedder = deps.embedder ?? createEmbeddingProvider(defaultEmbedProviderKind());
      const factClaimed = await mirrorClaim(store, factEmbedder, {
        id,
        kind: "fact",
        text: factTitle ? `${factTitle}\n${body}` : body,
        tags: factTags,
        weight: numberOption(options, "importance"),
        createdAt: factCreatedAt,
      });
      return json
        ? `${JSON.stringify({ upserted: id, kind, claim: factClaimed }, null, 2)}\n`
        : `Fact upserted: ${id} (${kind})${factClaimed ? " [claim]" : ""}\n`;
    }

    if (command === "add-claim") {
      const id = stringOption(options, "id");
      const kind = stringOption(options, "kind") as ClaimKind | undefined;
      const text = stringOption(options, "text");
      if (!id) throw new Error("--id <claim-id> is required");
      if (!kind) throw new Error("--kind <lesson|fact|situation-claim> is required");
      if (!["lesson", "fact", "situation-claim"].includes(kind)) {
        throw new Error(`--kind must be one of: lesson, fact, situation-claim. Got: ${kind}`);
      }
      if (!text) throw new Error("--text <text> is required");
      const embedding = floatListOption(options, "embedding");
      await store.upsertClaim({
        id,
        kind,
        text,
        embedding: embedding ? new Float32Array(embedding) : null,
        embedModel: stringOption(options, "embed-model"),
        repo: stringOption(options, "repo"),
        tags: listOption(options, "tags"),
        sourceEpisode: stringOption(options, "source-episode"),
        weight: numberOption(options, "weight"),
        createdAt: numberOption(options, "created-at") ?? Date.now(),
      });
      return json
        ? `${JSON.stringify({ upserted: id, kind: "claim", claimKind: kind }, null, 2)}\n`
        : `Claim upserted: ${id} (${kind})\n`;
    }

    if (command === "recall-claims") {
      const vector = floatListOption(options, "query-vector");
      const queryText = stringOption(options, "query");
      const requestedKind = stringOption(options, "kind");
      const allowedKinds = [
        "lesson",
        "fact",
        "situation-claim",
        "curated_fact",
        "routing_memory",
        "procedure",
      ] as const;
      if (
        requestedKind &&
        !allowedKinds.includes(requestedKind as (typeof allowedKinds)[number])
      ) {
        throw new Error(
          `--kind must be one of: ${allowedKinds.join(", ")}. Got: ${requestedKind}`,
        );
      }
      const factKind = isMemoryFactKind(requestedKind)
        ? requestedKind
        : undefined;
      let queryVector: Float32Array | undefined = vector ? new Float32Array(vector) : undefined;
      // --query <text> embeds in-process (query mode) so callers (e.g. the
      // learnings hook dedup) get semantic recall without precomputing a vector.
      if (!queryVector && queryText) {
        const embedder = deps.embedder ?? createEmbeddingProvider(defaultEmbedProviderKind());
        [queryVector] = await embedder.embed([queryText], "query");
      }
      const results = await store.recallClaims({
        queryVector,
        filters: {
          repo: stringOption(options, "repo"),
          kind: factKind ? "fact" : requestedKind as ClaimKind | undefined,
          factKind,
          tags: listOption(options, "tags"),
          sinceMs: numberOption(options, "since-ms"),
        },
        limit: numberOption(options, "limit"),
        // Inspection command — must NOT bump last_used_at or it self-pollutes
        // the fade signal (§7.1), same as the dashboard/eval read paths.
        recordUsage: false,
      });
      return json ? `${JSON.stringify({ results }, null, 2)}\n` : formatClaimRecall(results);
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

function isMemoryFactKind(
  kind: string | undefined,
): kind is MemoryFactInput["kind"] {
  return (
    kind === "curated_fact" ||
    kind === "routing_memory" ||
    kind === "procedure"
  );
}

function floatListOption(options: Map<string, string | true>, key: string): number[] | undefined {
  const value = stringOption(options, key);
  if (!value) return undefined;
  const nums = value.split(",").map((item) => Number(item.trim()));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`Invalid --${key}: ${value}`);
  return nums;
}

function entityListOption(options: Map<string, string | true>, key: string): Array<{ name: string; kind: string }> | undefined {
  const value = stringOption(options, key);
  if (!value) return undefined;
  return value.split(",").map((item) => {
    const [name, kind = "unknown"] = item.trim().split(":");
    return { name: name.trim(), kind: kind.trim() };
  }).filter((e) => e.name.length > 0);
}

function formatClaimRecall(results: ClaimRecallResult[]): string {
  if (results.length === 0) return "No claims found.\n";
  return results
    .map((result, index) => {
      const cos = result.cosine != null ? `, cos ${result.cosine.toFixed(3)}` : "";
      return [
        `${index + 1}. ${result.id} (${result.factKind ?? result.kind}, score ${result.score.toFixed(3)}${cos})`,
        result.text,
        `repo: ${result.repo ?? "none"} | tags: ${result.tags.join(", ") || "none"} | weight: ${result.weight}`,
      ].join("\n");
    })
    .join("\n\n") + "\n";
}

function formatConsolidateV3(reports: ConsolidateV3Entry[]): string {
  if (reports.length === 0) return "No unconsolidated source records.\n";
  return reports
    .map(({ threadIds, report, error }) => {
      const scope = threadIds.length ? threadIds.join(", ") : "(all unthreaded)";
      if (error) return `${scope}: FAILED — ${error}`;
      if (!report || report.skipped) return `${scope}: skipped (nothing to consolidate)`;
      return [
        `${scope}:`,
        `  records processed: ${report.recordsProcessed}`,
        `  episodes: ${report.episodes}`,
        `  profiles: ${report.profiles}`,
        `  claims written: ${report.claimsWritten} (deduped ${report.claimsDeduped})`,
      ].join("\n");
    })
    .join("\n") + "\n";
}

function usage(): string {
  return [
    "Usage:",
    "  bun run src/memory/cli.ts consolidate-v3 [--thread <id>] [--limit n] [--max-batch-chars n] [--body-cap n] [--kinds slack_message,curated_fact,...] [--runner claude|opencode|codex] [--model <model>] [--effort low|medium|high] [--timeout-ms n] [--json]",
    "  bun run src/memory/cli.ts add-lesson --id <id> --title <title> --body <body> [--applies-when <text>] [--importance 0-1] [--source-ids a,b] [--tags x,y] [--entities name:kind,...] [--json]",
    "  bun run src/memory/cli.ts add-fact --id <id> --kind <curated_fact|routing_memory|procedure> --body <body> [--title <title>] [--confidence 0-1] [--importance 0-1] [--source-ids a,b] [--tags x,y] [--entities name:kind,...] [--json]",
    "  bun run src/memory/cli.ts add-claim --id <id> --kind <lesson|fact|situation-claim> --text <text> [--repo <name>] [--tags x,y] [--source-episode <id>] [--weight 0-N] [--embedding 0.1,0.2,...] [--embed-model <name>] [--json]",
    "  bun run src/memory/cli.ts recall-claims [--query <text> | --query-vector 0.1,0.2,...] [--repo <name>] [--kind <lesson|fact|situation-claim|curated_fact|routing_memory|procedure>] [--tags x,y] [--since-ms <epoch-ms>] [--limit n] [--json]",
  ].join("\n") + "\n";
}
