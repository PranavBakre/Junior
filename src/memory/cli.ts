import { createMemoryStore } from "./factory.ts";
import type { MemoryFactInput, MemoryMergeResult, MemoryRecallOptions, SearchableMemoryKind } from "./types.ts";
import {
  entitiesForMessage,
  importanceForText,
  slug,
  sourceIdFor,
  tagsForMessage,
} from "./ingestion.ts";

const VALID_CORRECTION_FIELDS = new Set(["tag", "event_type", "edge", "promotion", "archive", "routing_fact", "validity"]);
const VALID_CORRECTION_ACTORS = new Set(["user", "agent", "reviewer"]);
const VALID_RULE_DOMAINS = new Set(["tag", "event_type", "edge", "promotion", "archive", "routing_fact"]);

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

    if (command === "accept-rule" || command === "reject-rule") {
      const id = stringOption(options, "id");
      if (!id) throw new Error("--id <rule-id> is required");
      const status = command === "accept-rule" ? "accepted" : "rejected";
      const ok = await store.setRuleStatus(id, status);
      return json
        ? `${JSON.stringify({ [status]: ok, id }, null, 2)}\n`
        : (ok ? `Rule ${status}: ${id}\n` : `Rule not found: ${id}\n`);
    }

    if (command === "accepted-rules") {
      const rules = await store.getAcceptedRules();
      return json
        ? `${JSON.stringify({ rules }, null, 2)}\n`
        : rules.length === 0 ? "No accepted rules.\n" : rules.map((rule) => `${rule.id} | ${rule.domain} | ${rule.ruleText}`).join("\n") + "\n";
    }

    if (command === "add-lesson") {
      const id = stringOption(options, "id");
      const title = stringOption(options, "title");
      const body = stringOption(options, "body");
      if (!id) throw new Error("--id <lesson-id> is required");
      if (!title) throw new Error("--title <title> is required");
      if (!body) throw new Error("--body <body> is required");
      const sourceIds = listOption(options, "source-ids");
      await store.upsertLesson({
        id,
        title,
        body,
        appliesWhen: stringOption(options, "applies-when"),
        importance: numberOption(options, "importance"),
        createdAt: numberOption(options, "created-at") ?? Date.now(),
        sourceIds,
        tags: listOption(options, "tags"),
        entities: entityListOption(options, "entities"),
      });
      // Auto-create edges to source events for graph traversal
      const createdEdges: string[] = [];
      if (sourceIds) {
        for (const srcId of sourceIds) {
          await store.addEdge({ srcId: id, dstId: srcId, type: "lesson_from", weight: 1, createdAt: Date.now() });
          createdEdges.push(srcId);
        }
      }
      return json
        ? `${JSON.stringify({ upserted: id, kind: "lesson", edges: createdEdges }, null, 2)}\n`
        : `Lesson upserted: ${id}${createdEdges.length ? ` (${createdEdges.length} edge(s))` : ""}\n`;
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
      await store.upsertFact({
        id,
        kind,
        title: stringOption(options, "title"),
        body,
        confidence: numberOption(options, "confidence"),
        importance: numberOption(options, "importance"),
        createdAt: numberOption(options, "created-at") ?? Date.now(),
        sourceIds,
        tags: listOption(options, "tags"),
        entities: entityListOption(options, "entities"),
      });
      // Auto-create edges to source events for graph traversal
      const createdEdges: string[] = [];
      if (sourceIds) {
        for (const srcId of sourceIds) {
          await store.addEdge({ srcId: id, dstId: srcId, type: "derived_from", weight: 1, createdAt: Date.now() });
          createdEdges.push(srcId);
        }
      }
      return json
        ? `${JSON.stringify({ upserted: id, kind, edges: createdEdges }, null, 2)}\n`
        : `Fact upserted: ${id} (${kind})${createdEdges.length ? ` (${createdEdges.length} edge(s))` : ""}\n`;
    }

    if (command === "add-event") {
      const now = Date.now();
      const id = stringOption(options, "id") ?? `event_cli_${slug(String(now))}`;
      const body = stringOption(options, "body");
      if (!body) throw new Error("--body <body> is required");

      const threadId = stringOption(options, "thread-id") ?? `cli-${slug(String(now))}`;
      const sourceRecordId = stringOption(options, "source-id") ?? sourceIdFor("cli", threadId, String(now), id);
      const tags = listOption(options, "tags") ?? tagsForMessage(body, null, stringOption(options, "agent") ?? "cli");
      const entities = entityListOption(options, "entities") ?? entitiesForMessage(body);
      const importance = numberOption(options, "importance") ?? importanceForText(body, null);

      // Auto-create a source record if one wasn't explicitly provided.
      const explicitSource = stringOption(options, "source-id");
      if (!explicitSource) {
        await store.appendSourceRecord({
          id: sourceRecordId,
          kind: "curated_fact",
          threadId,
          body,
          actorKind: "system",
          agentName: stringOption(options, "agent") ?? "cli",
          createdAt: now,
        });
      }

      await store.upsertEvent({
        id,
        sourceRecordId,
        threadId,
        body,
        outcome: stringOption(options, "outcome"),
        importance,
        createdAt: numberOption(options, "created-at") ?? now,
        sourceTs: stringOption(options, "source-ts") ?? String(now),
        sourceUrl: stringOption(options, "source-url"),
        tags,
        entities,
      });
      return json
        ? `${JSON.stringify({ upserted: id, kind: "event", sourceRecordId, tags, importance, entities }, null, 2)}\n`
        : `Event upserted: ${id} (tags: ${tags.join(", ")}, importance: ${importance})\n`;
    }

    if (command === "add-edge") {
      const srcId = stringOption(options, "src");
      const dstId = stringOption(options, "dst");
      const type = stringOption(options, "type") ?? "related";
      const weight = numberOption(options, "weight") ?? 1;
      const directed = booleanOption(options, "directed") ?? true;
      if (!srcId) throw new Error("--src <src-id> is required");
      if (!dstId) throw new Error("--dst <dst-id> is required");
      await store.addEdge({ srcId, dstId, type, weight, directed, createdAt: Date.now() });
      return json
        ? `${JSON.stringify({ edge: { srcId, dstId, type, weight, directed }, ok: true }, null, 2)}\n`
        : `Edge created: ${srcId} --[${type}]--> ${dstId}\n`;
    }

    if (command === "update-lesson") {
      const id = stringOption(options, "id");
      if (!id) throw new Error("--id <lesson-id> is required");
      await store.updateLesson(id, {
        title: stringOption(options, "title"),
        body: stringOption(options, "body"),
        appliesWhen: stringOption(options, "applies-when"),
        importance: numberOption(options, "importance"),
        addSourceIds: listOption(options, "add-source-ids"),
        addTags: listOption(options, "add-tags"),
        addEntities: entityListOption(options, "add-entities"),
      });
      return json
        ? `${JSON.stringify({ updated: id, kind: "lesson" }, null, 2)}\n`
        : `Lesson updated: ${id}\n`;
    }

    if (command === "update-fact") {
      const id = stringOption(options, "id");
      if (!id) throw new Error("--id <fact-id> is required");
      const kind = stringOption(options, "kind") as MemoryFactInput["kind"] | undefined;
      if (kind && !["curated_fact", "routing_memory", "procedure"].includes(kind)) {
        throw new Error(`--kind must be one of: curated_fact, routing_memory, procedure. Got: ${kind}`);
      }
      await store.updateFact(id, {
        kind,
        title: stringOption(options, "title"),
        body: stringOption(options, "body"),
        confidence: numberOption(options, "confidence"),
        importance: numberOption(options, "importance"),
        addSourceIds: listOption(options, "add-source-ids"),
        addTags: listOption(options, "add-tags"),
        addEntities: entityListOption(options, "add-entities"),
      });
      return json
        ? `${JSON.stringify({ updated: id, kind: "fact" }, null, 2)}\n`
        : `Fact updated: ${id}\n`;
    }

    if (command === "merge-lessons") {
      const ids = listOption(options, "ids");
      const title = stringOption(options, "title");
      if (!ids || ids.length < 2) throw new Error("--ids <id1,id2,...> with at least 2 IDs is required");
      if (!title) throw new Error("--title <title> is required");
      const result: MemoryMergeResult = await store.mergeLessons(ids, title);
      return json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Merged ${result.sourceIds.length} lessons into ${result.mergedId} (${result.supersededIds.join(", ")} superseded)\n`;
    }

    if (command === "merge-facts") {
      const ids = listOption(options, "ids");
      const title = stringOption(options, "title");
      if (!ids || ids.length < 2) throw new Error("--ids <id1,id2,...> with at least 2 IDs is required");
      if (!title) throw new Error("--title <title> is required");
      const result: MemoryMergeResult = await store.mergeFacts(ids, title);
      return json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Merged ${result.sourceIds.length} facts into ${result.mergedId} (${result.supersededIds.join(", ")} superseded)\n`;
    }

    if (command === "log-correction") {
      const eventId = stringOption(options, "event-id");
      const field = stringOption(options, "field");
      const correctValue = stringOption(options, "correct");
      const incorrectValue = stringOption(options, "incorrect");
      const correctedBy = stringOption(options, "by") ?? "user";
      if (!eventId) throw new Error("--event-id <id> is required");
      if (!field) throw new Error("--field <field> is required");
      if (!correctValue) throw new Error("--correct <value> is required");
      if (!isValidCorrectionField(field)) {
        throw new Error(`--field must be one of: tag, event_type, edge, promotion, archive, routing_fact, validity. Got: ${field}`);
      }
      if (!isValidCorrectionActor(correctedBy)) {
        throw new Error(`--by must be one of: user, agent, reviewer. Got: ${correctedBy}`);
      }

      // Auto-create a source record for the correction.
      const now = Date.now();
      const sourceId = sourceIdFor("correction", eventId, String(now), correctedBy);
      await store.appendSourceRecord({
        id: sourceId,
        kind: "ingestion_correction",
        threadId: eventId,
        body: `Correction by ${correctedBy}: ${field} from "${incorrectValue ?? "(none)"}" to "${correctValue}"`,
        actorKind: "human",
        createdAt: now,
      });

      await store.logCorrection({
        eventId,
        field,
        incorrectValue: incorrectValue ?? null,
        correctValue,
        correctedBy,
        createdAt: now,
      });
      return json
        ? `${JSON.stringify({ correction: { eventId, field, correctValue, sourceId }, ok: true }, null, 2)}\n`
        : `Correction logged: ${eventId} field="${field}" → "${correctValue}"\n`;
    }

    if (command === "propose-rule") {
      const id = stringOption(options, "id");
      const domain = stringOption(options, "domain");
      const ruleText = stringOption(options, "rule");
      const positiveIds = listOption(options, "positive-examples") ?? [];
      const negativeIds = listOption(options, "negative-examples") ?? [];
      if (!id) throw new Error("--id <rule-id> is required");
      if (!domain) throw new Error("--domain <tag|event_type|edge|promotion|archive|routing_fact> is required");
      if (!isValidRuleDomain(domain)) {
        throw new Error(`--domain must be one of: tag, event_type, edge, promotion, archive, routing_fact. Got: ${domain}`);
      }
      if (!ruleText) throw new Error("--rule <rule-text> is required");
      await store.proposeRule({
        id,
        status: "draft",
        domain,
        ruleText,
        positiveExampleIds: positiveIds,
        negativeExampleIds: negativeIds,
        precision: numberOption(options, "precision"),
        recall: numberOption(options, "recall"),
        createdAt: Date.now(),
      });
      return json
        ? `${JSON.stringify({ proposed: id, domain, status: "draft" }, null, 2)}\n`
        : `Rule proposed: ${id} (domain=${domain}, status=draft)\n`;
    }

    if (command === "rebuild-fts") {
      await store.rebuildSearchIndex();
      return json
        ? `${JSON.stringify({ rebuilt: "memory_fts", ok: true }, null, 2)}\n`
        : `FTS index rebuilt.\n`;
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

function isValidCorrectionField(field: string): field is "tag" | "event_type" | "edge" | "promotion" | "archive" | "routing_fact" | "validity" {
  return VALID_CORRECTION_FIELDS.has(field);
}

function isValidCorrectionActor(actor: string): actor is "user" | "agent" | "reviewer" {
  return VALID_CORRECTION_ACTORS.has(actor);
}

function isValidRuleDomain(domain: string): domain is "tag" | "event_type" | "edge" | "promotion" | "archive" | "routing_fact" {
  return VALID_RULE_DOMAINS.has(domain);
}

function entityListOption(options: Map<string, string | true>, key: string): Array<{ name: string; kind: string }> | undefined {
  const value = stringOption(options, key);
  if (!value) return undefined;
  return value.split(",").map((item) => {
    const [name, kind = "unknown"] = item.trim().split(":");
    return { name: name.trim(), kind: kind.trim() };
  }).filter((e) => e.name.length > 0);
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
    "  bun run src/memory/cli.ts recall --query <text> [--tags a,b] [--entities x,y] [--kinds a,b] [--limit n] [--json]",
    "  bun run src/memory/cli.ts consolidate [--json]",
    "  bun run src/memory/cli.ts accept-rule --id <rule-id> [--json]",
    "  bun run src/memory/cli.ts reject-rule --id <rule-id> [--json]",
    "  bun run src/memory/cli.ts accepted-rules [--json]",
    "  bun run src/memory/cli.ts add-lesson --id <id> --title <title> --body <body> [--applies-when <text>] [--importance 0-1] [--source-ids a,b] [--tags x,y] [--entities name:kind,...] [--json]",
    "  bun run src/memory/cli.ts add-fact --id <id> --kind <curated_fact|routing_memory|procedure> --body <body> [--title <title>] [--confidence 0-1] [--importance 0-1] [--source-ids a,b] [--tags x,y] [--entities name:kind,...] [--json]",
    "  bun run src/memory/cli.ts add-event --body <text> [--id <id>] [--thread-id <id>] [--agent <name>] [--outcome <text>] [--source-url <url>] [--tags x,y] [--entities name:kind,...] [--importance 0-1] [--json]",
    "  bun run src/memory/cli.ts add-edge --src <id> --dst <id> [--type <type>] [--weight 0-1] [--directed] [--json]",
    "  bun run src/memory/cli.ts update-lesson --id <id> [--title <text>] [--body <text>] [--applies-when <text>] [--importance 0-1] [--add-source-ids a,b] [--add-tags x,y] [--add-entities name:kind,...] [--json]",
    "  bun run src/memory/cli.ts update-fact --id <id> [--kind <curated_fact|routing_memory|procedure>] [--title <text>] [--body <text>] [--confidence 0-1] [--importance 0-1] [--add-source-ids a,b] [--add-tags x,y] [--add-entities name:kind,...] [--json]",
    "  bun run src/memory/cli.ts merge-lessons --ids <id1,id2,...> --title <title> [--json]",
    "  bun run src/memory/cli.ts merge-facts --ids <id1,id2,...> --title <title> [--json]",
    "  bun run src/memory/cli.ts log-correction --event-id <id> --field <field> --correct <value> [--incorrect <value>] [--by <who>] [--json]",
    "  bun run src/memory/cli.ts propose-rule --id <id> --domain <domain> --rule <text> [--positive-examples a,b] [--negative-examples a,b] [--precision 0-1] [--recall 0-1] [--json]",
    "  bun run src/memory/cli.ts rebuild-fts [--json]",
  ].join("\n") + "\n";
}
