import { createMemoryStore } from "./factory.ts";
import type {
  ArchiveStaleClaimsResult,
  ClaimKind,
  ClaimRecallResult,
  ClaimWriteResult,
  MemoryFactInput,
} from "./types.ts";
import { formatDedupSweep, runDedupSweep } from "./dedup-sweep.ts";
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
import {
  buildFactRetrievalText,
  buildLessonRetrievalText,
  buildLessonRetrievalTexts,
} from "./retrieval-text.ts";

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
 *
 * Returns the store's write result (null when the mirror was skipped) so the
 * caller can report whether the claim was stored or merged into a near-duplicate
 * that was already there.
 */
async function mirrorClaim(
  store: ReturnType<typeof createMemoryStore>,
  embedder: EmbeddingProvider,
  claim: {
    id: string;
    kind: "lesson" | "fact";
    text: string;
    retrievalText?: string;
    retrievalTexts?: string[];
    tags?: string[];
    weight?: number;
    createdAt: number;
  },
): Promise<ClaimWriteResult | null> {
  // Embed and store are reported separately: one catch around both blamed the
  // embedder for every store-side throw (a failed guard, a locked DB), which
  // sends the reader looking at the wrong component.
  let embedding: Float32Array;
  let retrievalEmbeddings: Array<{ text: string; embedding: Float32Array }> | undefined;
  try {
    const retrievalTexts = claim.retrievalTexts ?? [claim.retrievalText ?? claim.text];
    const texts = claim.retrievalTexts
      ? [claim.text, ...retrievalTexts]
      : retrievalTexts;
    const vectors = await embedder.embed(texts, "document");
    embedding = vectors[0]!;
    retrievalEmbeddings = retrievalTexts.map((text, index) => ({
      text,
      embedding: vectors[index + (claim.retrievalTexts ? 1 : 0)]!,
    }));
  } catch (err) {
    console.error(
      `[add] claim mirror skipped (embed failed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  try {
    return await store.upsertClaim({
      id: claim.id,
      kind: claim.kind,
      text: claim.text,
      retrievalText: claim.retrievalTexts?.[0] ?? claim.retrievalText,
      embedding,
      retrievalEmbeddings,
      embedModel: embedder.model,
      dim: embedder.dim,
      tags: claim.tags,
      // Only forward an EXPLICIT --importance. Passing a 1.0 default here would
      // reset the accumulated weight of a claim that already exists under this id.
      weight: claim.weight,
      createdAt: claim.createdAt,
      active: true,
    });
  } catch (err) {
    console.error(
      `[add] claim mirror skipped (store write failed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Human-readable tail for an add-* command: what the claim mirror actually did. */
function claimSuffix(result: ClaimWriteResult | null): string {
  if (!result) return "";
  return result.action === "merged"
    ? ` [claim merged into ${result.id}]`
    : ` [claim ${result.action}]`;
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
        personaAll: booleanOption(options, "persona-all") === true,
        profilesAll: booleanOption(options, "profiles-all") === true,
        subjectsAll: booleanOption(options, "subjects-all") === true,
        subjectRepoNames: listOption(options, "subject-repos"),
        personaActorIds: listOption(options, "persona-actors"),
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
      const appliesWhen = stringOption(options, "applies-when");
      await store.upsertLesson({
        id,
        title,
        body,
        appliesWhen,
        importance: numberOption(options, "importance"),
        createdAt: lessonCreatedAt,
        sourceIds,
        tags: lessonTags,
        entities: entityListOption(options, "entities"),
      });
      // Mirror into the semantic claim store so v3 memory_recall can find it.
      const lessonEmbedder = deps.embedder ?? createEmbeddingProvider(defaultEmbedProviderKind());
      const lessonClaim = await mirrorClaim(store, lessonEmbedder, {
        id,
        kind: "lesson",
        text: `${title}\n${body}`,
        retrievalText: buildLessonRetrievalText({ title, body, appliesWhen }),
        retrievalTexts: buildLessonRetrievalTexts({ title, body, appliesWhen }),
        tags: lessonTags,
        weight: numberOption(options, "importance"),
        createdAt: lessonCreatedAt,
      });
      return json
        ? `${JSON.stringify(
            {
              upserted: id,
              kind: "lesson",
              claim: lessonClaim != null,
              claimId: lessonClaim?.id ?? null,
              claimAction: lessonClaim?.action ?? null,
            },
            null,
            2,
          )}\n`
        : `Lesson upserted: ${id}${claimSuffix(lessonClaim)}\n`;
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
      const factClaim = await mirrorClaim(store, factEmbedder, {
        id,
        kind: "fact",
        text: factTitle ? `${factTitle}\n${body}` : body,
        retrievalText: buildFactRetrievalText({ title: factTitle, body }),
        tags: factTags,
        weight: numberOption(options, "importance"),
        createdAt: factCreatedAt,
      });
      return json
        ? `${JSON.stringify(
            {
              upserted: id,
              kind,
              claim: factClaim != null,
              claimId: factClaim?.id ?? null,
              claimAction: factClaim?.action ?? null,
            },
            null,
            2,
          )}\n`
        : `Fact upserted: ${id} (${kind})${claimSuffix(factClaim)}\n`;
    }

    if (command === "add-claim") {
      const id = stringOption(options, "id");
      const kind = stringOption(options, "kind") as ClaimKind | undefined;
      const text = stringOption(options, "text");
      if (!id) throw new Error("--id <claim-id> is required");
      if (!kind) throw new Error("--kind <lesson|fact|preference|decision|situation-claim> is required");
      if (!["lesson", "fact", "preference", "decision", "situation-claim"].includes(kind)) {
        throw new Error(`--kind must be one of: lesson, fact, preference, decision, situation-claim. Got: ${kind}`);
      }
      if (!text) throw new Error("--text <text> is required");
      const explicitEmbedding = floatListOption(options, "embedding");
      const skipDedup = booleanOption(options, "skip-dedup") === true;
      if (kind === "lesson" && explicitEmbedding && !skipDedup) {
        throw new Error(
          "add-claim --kind lesson cannot use --embedding because lesson retrieval variants would be missing; use add-lesson instead",
        );
      }
      let embedding: Float32Array | null = explicitEmbedding
        ? new Float32Array(explicitEmbedding)
        : null;
      let embedModel = stringOption(options, "embed-model");
      let embedDim: number | undefined = embedding?.length;
      let retrievalText: string | undefined;
      let retrievalEmbeddings:
        | Array<{ text: string; embedding: Float32Array }>
        | undefined;
      // The store never embeds and rejects an unguardable, cosine-invisible row.
      // Embed here so `add-claim` stays usable without --embedding; --skip-dedup
      // is the explicit escape hatch for a verbatim restore write.
      if (!embedding && !skipDedup) {
        const claimEmbedder = deps.embedder ?? createEmbeddingProvider(defaultEmbedProviderKind());
        if (kind === "lesson") {
          const [firstLine = text, ...remainingLines] = text.split(/\r?\n/);
          const lessonTexts = buildLessonRetrievalTexts({
            title: firstLine.trim(),
            body: remainingLines.join("\n").trim() || text,
          });
          const vectors = await claimEmbedder.embed([text, ...lessonTexts], "document");
          embedding = vectors[0]!;
          retrievalText = lessonTexts[0];
          retrievalEmbeddings = lessonTexts.map((variantText, index) => ({
            text: variantText,
            embedding: vectors[index + 1]!,
          }));
        } else {
          [embedding] = await claimEmbedder.embed([text], "document");
        }
        embedModel = embedModel ?? claimEmbedder.model;
        embedDim = claimEmbedder.dim;
      }
      const written = await store.upsertClaim({
        id,
        kind,
        text,
        retrievalText,
        embedding,
        retrievalEmbeddings,
        embedModel,
        dim: embedDim,
        repo: stringOption(options, "repo"),
        tags: listOption(options, "tags"),
        sourceEpisode: stringOption(options, "source-episode"),
        sourcePath: stringOption(options, "source-path"),
        sourceHeading: stringOption(options, "source-heading"),
        sourceText: stringOption(options, "source-text"),
        weight: numberOption(options, "weight"),
        createdAt: numberOption(options, "created-at") ?? Date.now(),
        skipDedup,
      });
      return json
        ? `${JSON.stringify(
            { upserted: written.id, kind: "claim", claimKind: kind, action: written.action },
            null,
            2,
          )}\n`
        : written.action === "merged"
          ? `Claim merged into ${written.id} (${kind}) — near-duplicate of an existing claim\n`
          : `Claim ${written.action}: ${written.id} (${kind})\n`;
    }

    if (command === "dedup-sweep") {
      // Offline backfill for the near-duplicates that predate the write guard.
      // DRY RUN unless --apply, matching migrate-v3: a merged-away claim is
      // recoverable only from provenance, so the operator sees the plan first.
      const report = await runDedupSweep({
        store,
        threshold: numberOption(options, "threshold"),
        apply: booleanOption(options, "apply"),
      });
      return json ? `${JSON.stringify(report, null, 2)}\n` : formatDedupSweep(report);
    }

    if (command === "archive-stale") {
      const apply = booleanOption(options, "apply") === true;
      if (apply && (options.has("older-than-ms") || options.has("max-weight"))) {
        throw new Error(
          "--apply uses configured MEMORY_ARCHIVE_OLDER_THAN_MS and MEMORY_ARCHIVE_MAX_WEIGHT; threshold overrides are dry-run only",
        );
      }
      const olderThanMs = numberOption(options, "older-than-ms") ??
        Number(process.env.MEMORY_ARCHIVE_OLDER_THAN_MS ?? 90 * 24 * 60 * 60 * 1000);
      const maxWeight = numberOption(options, "max-weight") ??
        Number(process.env.MEMORY_ARCHIVE_MAX_WEIGHT ?? 0.5);
      if (!Number.isInteger(olderThanMs) || olderThanMs <= 0) {
        throw new Error("--older-than-ms must be a positive integer");
      }
      if (!Number.isFinite(maxWeight) || maxWeight < 0) {
        throw new Error("--max-weight must be a non-negative number");
      }
      const report = await store.archiveStaleClaims({
        olderThanMs,
        maxWeight,
        apply,
      });
      return json
        ? `${JSON.stringify({ ...report, olderThanMs, maxWeight }, null, 2)}\n`
        : formatArchiveStale(report, { olderThanMs, maxWeight });
    }

    if (command === "recall-claims") {
      const vector = floatListOption(options, "query-vector");
      const queryText = stringOption(options, "query");
      const requestedKind = stringOption(options, "kind");
      const allowedKinds = [
        "lesson",
        "fact",
        "preference",
        "decision",
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
        queryText,
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
      const lex = result.lexicalScore != null
        ? `, lexical ${result.lexicalScore.toFixed(3)}`
        : "";
      return [
        `${index + 1}. ${result.id} (${result.factKind ?? result.kind}, score ${result.score.toFixed(3)}${cos}${lex})`,
        result.text,
        ...(result.sourcePath
          ? [`source: ${result.sourcePath}${result.sourceHeading ? ` # ${result.sourceHeading}` : ""}`]
          : []),
        `repo: ${result.repo ?? "none"} | tags: ${result.tags.join(", ") || "none"} | weight: ${result.weight}`,
      ].join("\n");
    })
    .join("\n\n") + "\n";
}

function formatConsolidateV3(reports: ConsolidateV3Entry[]): string {
  if (reports.length === 0) return "No unconsolidated source records.\n";
  return reports
    .map(({ threadIds, report, persona, subject, error }) => {
      if (persona) {
        const who = persona.displayName
          ? `${persona.displayName} (${persona.actorId})`
          : persona.actorId;
        if (persona.error) return `persona ${who}: FAILED — ${persona.error}`;
        return `persona ${who}: ${persona.recordsReviewed} records reviewed → ${
          persona.profileUpdated
            ? `profile updated (${persona.entityRef})`
            : `unchanged (${persona.skippedReason ?? "no durable change"})`
        }`;
      }
      if (subject) {
        if (subject.error) return `${subject.kind} ${subject.subject}: FAILED — ${subject.error}`;
        return `${subject.kind} ${subject.subject}: ${subject.recordsReviewed} records reviewed → ${
          subject.profilesUpdated > 0
            ? `${subject.profilesUpdated} profile(s) updated`
            : `unchanged (${subject.skippedReason ?? "no durable change"})`
        }`;
      }
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
    "  bun run src/memory/cli.ts consolidate-v3 [--profiles-all | --subjects-all | --subject-repos name,... | --persona-all | --persona-actors U123,U456] [--thread <id>] [--limit n] [--max-batch-chars n] [--body-cap n] [--kinds slack_message,curated_fact,...] [--runner claude|opencode|codex] [--model <model>] [--effort low|medium|high] [--timeout-ms n] [--json]",
    "  bun run src/memory/cli.ts add-lesson --id <id> --title <title> --body <body> [--applies-when <text>] [--importance 0-1] [--source-ids a,b] [--tags x,y] [--entities name:kind,...] [--json]",
    "  bun run src/memory/cli.ts add-fact --id <id> --kind <curated_fact|routing_memory|procedure> --body <body> [--title <title>] [--confidence 0-1] [--importance 0-1] [--source-ids a,b] [--tags x,y] [--entities name:kind,...] [--json]",
    "  bun run src/memory/cli.ts add-claim --id <id> --kind <lesson|fact|preference|decision|situation-claim> --text <text> [--repo <name>] [--tags x,y] [--source-episode <id>] [--source-path <path>] [--source-heading <heading>] [--source-text <section>] [--weight 0-N] [--embedding 0.1,0.2,...] [--embed-model <name>] [--skip-dedup] [--json]",
    "  bun run src/memory/cli.ts dedup-sweep [--threshold 0.92] [--apply] [--json]   (DRY RUN without --apply)",
    "  bun run src/memory/cli.ts archive-stale [--older-than-ms n] [--max-weight n] [--apply] [--json]   (DRY RUN without --apply)",
    "  bun run src/memory/cli.ts recall-claims [--query <text> | --query-vector 0.1,0.2,...] [--repo <name>] [--kind <lesson|fact|preference|decision|procedure|situation-claim|curated_fact|routing_memory>] [--tags x,y] [--since-ms <epoch-ms>] [--limit n] [--json]",
  ].join("\n") + "\n";
}

function formatArchiveStale(
  report: ArchiveStaleClaimsResult,
  thresholds: { olderThanMs: number; maxWeight: number },
): string {
  return [
    `Stale claim archive ${report.applied ? "APPLIED" : "DRY RUN"}`,
    `Thresholds: olderThanMs=${thresholds.olderThanMs} maxWeight=${thresholds.maxWeight}`,
    `Candidates: ${report.candidateIds.length}`,
    `Archived: ${report.archivedIds.length}`,
    report.candidateIds.length > 0 ? `Candidate IDs: ${report.candidateIds.join(", ")}` : null,
  ].filter((line): line is string => line !== null).join("\n") + "\n";
}
