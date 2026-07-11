// Notion sync (whatsapp-hermes-tracker §Notion sync, docs/features/whatsapp-hermes-tracker.md).
//
// SQLite is the source of truth (src/whatsapp/); this module upserts a
// tasklist view into a Notion database on the Hermes page and hands back the
// new page ids so the caller can persist them alongside the SQLite rows.
//
// Notion is rate-limited to ~3 requests/second, so syncTasks() runs strictly
// serially with a pacing delay between calls, plus a single retry on 429
// honoring Retry-After (see withRetry below -- the SDK's own built-in retry
// is disabled in client.ts so this is the only retry layer, and it's testable
// against an injected fake client).
import type {
  CreateDatabaseResponse,
  CreatePageParameters,
  GetDatabaseResponse,
} from "@notionhq/client";

import { createNotionClient, type NotionApi } from "./client.ts";
import type { SyncResult, TaskForSync } from "./types.ts";

const TASKS_DATABASE_TITLE = "Hermes Buildathon Tasks";

/**
 * Rich-text property holding the task's stable SQLite id. It's the dedupe key
 * for the create path: before creating a page we query for an existing one with
 * this id, so a crash that persisted a page but not its id locally can't produce
 * a duplicate Notion page on the next sweep.
 */
const TASK_ID_PROPERTY = "Task ID";

/** ~3 rps serial pacing between page create/update calls. */
const DEFAULT_RATE_LIMIT_DELAY_MS = 350;

/** Fallback delay when a 429 has no (or an unparseable) Retry-After header. */
const DEFAULT_RETRY_DELAY_MS = 1000;

export interface NotionSyncConfig {
  token: string;
  pageId: string;
  /** Injectable client override for tests -- bypasses createNotionClient/network entirely. */
  client?: NotionApi;
  /** Injectable sleep for tests -- defaults to a real timer-based delay. */
  sleep?: (ms: number) => Promise<void>;
}

/** Fired the instant a create resolves, so the caller can persist the page id immediately. */
export type OnPageCreated = (taskId: string, pageId: string) => void;

export interface NotionSync {
  /** Finds (or creates) the Hermes tasks database as a child of pageId. Cached after first call. */
  ensureTasksDatabase(): Promise<string>;
  /**
   * Upserts tasks into the database: existing notionPageId -> update, else -> a
   * create (deduped by Task ID first). `onPageCreated` fires right after each
   * create so the caller can persist the page id before the batch finishes.
   */
  syncTasks(tasks: TaskForSync[], onPageCreated?: OnPageCreated): Promise<SyncResult>;
}

/**
 * Resolved database identity: the database id plus the data source id its schema
 * properties live on (v5 API). `canDedupe` is false when we couldn't guarantee
 * the `Task ID` property exists (an old manual database we failed to migrate) —
 * the create-path lookup is skipped rather than run against a missing property.
 */
interface DatabaseState {
  databaseId: string;
  dataSourceId: string | null;
  canDedupe: boolean;
}

export function createNotionSync(config: NotionSyncConfig): NotionSync {
  const client = config.client ?? createNotionClient(config.token);
  const sleep = config.sleep ?? defaultSleep;
  let state: DatabaseState | null = null;

  async function ensureTasksDatabase(): Promise<string> {
    return (await ensureState()).databaseId;
  }

  async function ensureState(): Promise<DatabaseState> {
    if (state) return state;

    const found = await findExistingTasksDatabase();
    state = found ? await adoptExistingDatabase(found) : await createTasksDatabase();
    return state;
  }

  async function createTasksDatabase(): Promise<DatabaseState> {
    const created = await client.databases.create({
      parent: { type: "page_id", page_id: config.pageId },
      title: [{ type: "text", text: { content: TASKS_DATABASE_TITLE } }],
      initial_data_source: {
        properties: {
          Task: { title: {} },
          [TASK_ID_PROPERTY]: { rich_text: {} },
          Owner: { select: {} },
          Priority: {
            select: { options: [{ name: "p0" }, { name: "p1" }, { name: "p2" }] },
          },
          Status: {
            select: {
              options: [
                { name: "open" },
                { name: "in-progress" },
                { name: "done" },
                { name: "blocked" },
              ],
            },
          },
          Notes: { rich_text: {} },
          Group: { rich_text: {} },
          Updated: { date: {} },
        },
      },
    });

    const dataSourceId = dataSourceIdOf(created);
    if (!dataSourceId) {
      // Shouldn't happen for a database we just created with an initial data
      // source, but if the response is partial we can't dedupe safely.
      console.warn(
        "[notion] created tasks database returned no data source id — Task ID dedupe disabled",
      );
    }
    // The freshly created schema includes Task ID, so dedupe is safe whenever we
    // resolved a data source id.
    return { databaseId: created.id, dataSourceId, canDedupe: dataSourceId !== null };
  }

  /**
   * Adopt a tasks database found from a prior run. It may predate the Task ID
   * property (created by an earlier manual run), so add that property to its
   * data source idempotently. If we can't resolve the data source or the update
   * fails, disable dedupe (log a warning) rather than query a missing property.
   */
  async function adoptExistingDatabase(databaseId: string): Promise<DatabaseState> {
    let dataSourceId: string | null = null;
    try {
      const db = await client.databases.retrieve({ database_id: databaseId });
      dataSourceId = dataSourceIdOf(db);
    } catch (err) {
      console.warn(
        `[notion] could not retrieve existing tasks database ${databaseId}: ${errorMessage(err)} — Task ID dedupe disabled`,
      );
      return { databaseId, dataSourceId: null, canDedupe: false };
    }

    if (!dataSourceId) {
      console.warn(
        `[notion] existing tasks database ${databaseId} exposed no data source id — Task ID dedupe disabled`,
      );
      return { databaseId, dataSourceId: null, canDedupe: false };
    }

    try {
      // Adding a property that already exists is a no-op; this only backfills the
      // Task ID column for a database created before it was part of the schema.
      await client.dataSources.update({
        data_source_id: dataSourceId,
        properties: { [TASK_ID_PROPERTY]: { rich_text: {} } },
      });
      return { databaseId, dataSourceId, canDedupe: true };
    } catch (err) {
      console.warn(
        `[notion] could not ensure Task ID property on data source ${dataSourceId}: ${errorMessage(err)} — Task ID dedupe disabled`,
      );
      return { databaseId, dataSourceId, canDedupe: false };
    }
  }

  /**
   * Looks for a child_database block of pageId already titled
   * TASKS_DATABASE_TITLE. The block list is paginated (100 per page), so a page
   * with many blocks can push the tasks database past the first page — walk
   * has_more/next_cursor until found or exhausted, or we'd create a duplicate.
   */
  async function findExistingTasksDatabase(): Promise<string | null> {
    let cursor: string | undefined;
    do {
      const children = await client.blocks.children.list({
        block_id: config.pageId,
        start_cursor: cursor,
      });
      for (const block of children.results) {
        if (!("type" in block) || block.type !== "child_database") continue;
        if (block.child_database.title === TASKS_DATABASE_TITLE) {
          return block.id;
        }
      }
      cursor = children.has_more ? (children.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return null;
  }

  async function syncTasks(
    tasks: TaskForSync[],
    onPageCreated?: OnPageCreated,
  ): Promise<SyncResult> {
    const db = await ensureState();
    const result: SyncResult = { created: {}, updated: [], errors: [] };

    for (const task of tasks) {
      try {
        if (task.notionPageId) {
          await withRetry(
            () =>
              client.pages.update({
                page_id: task.notionPageId as string,
                properties: buildProperties(task),
              }),
            sleep,
          );
          result.updated.push(task.id);
        } else {
          // Crash-recovery dedupe: a page may already exist from a create whose
          // id we failed to persist locally. Reuse it (update in place) rather
          // than create a duplicate; still report it under `created` so the
          // caller persists the recovered page id.
          const existingPageId = await findPageIdByTaskId(db, task.id);
          if (existingPageId) {
            await withRetry(
              () =>
                client.pages.update({
                  page_id: existingPageId,
                  properties: buildProperties(task),
                }),
              sleep,
            );
            result.created[task.id] = existingPageId;
            onPageCreated?.(task.id, existingPageId);
          } else {
            const page = await withRetry(
              () =>
                client.pages.create({
                  parent: { database_id: db.databaseId },
                  properties: buildProperties(task),
                }),
              sleep,
            );
            result.created[task.id] = page.id;
            onPageCreated?.(task.id, page.id);
          }
        }
      } catch (err) {
        result.errors.push({ taskId: task.id, error: errorMessage(err) });
      }

      await sleep(DEFAULT_RATE_LIMIT_DELAY_MS);
    }

    return result;
  }

  /**
   * Find an existing page in the tasks data source whose Task ID equals `taskId`,
   * returning its page id or null. Returns null (no lookup) when dedupe is
   * disabled — an old database we couldn't confirm carries the Task ID property.
   */
  async function findPageIdByTaskId(
    db: DatabaseState,
    taskId: string,
  ): Promise<string | null> {
    if (!db.canDedupe || !db.dataSourceId) return null;

    const res = await withRetry(
      () =>
        client.dataSources.query({
          data_source_id: db.dataSourceId as string,
          filter: { property: TASK_ID_PROPERTY, rich_text: { equals: taskId } },
          page_size: 1,
        }),
      sleep,
    );
    const first = res.results[0];
    return first ? first.id : null;
  }

  return { ensureTasksDatabase, syncTasks };
}

/**
 * Pull the (single) data source id out of a database response. v5 databases
 * carry a `data_sources` array on the full object; a partial response omits it,
 * in which case we can't dedupe.
 */
function dataSourceIdOf(
  db: GetDatabaseResponse | CreateDatabaseResponse,
): string | null {
  if ("data_sources" in db && Array.isArray(db.data_sources) && db.data_sources.length > 0) {
    return db.data_sources[0]?.id ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Property mapping
// ---------------------------------------------------------------------------

type PageProperties = NonNullable<CreatePageParameters["properties"]>;

function buildProperties(task: TaskForSync): PageProperties {
  return {
    Task: { title: [{ type: "text", text: { content: task.task } }] },
    // Stable dedupe key — written on both create and update so an existing page
    // can always be matched back to its SQLite task on a later sweep.
    [TASK_ID_PROPERTY]: {
      rich_text: [{ type: "text", text: { content: task.id } }],
    },
    Owner: { select: task.owner ? { name: task.owner } : null },
    Priority: { select: task.priority ? { name: task.priority } : null },
    Status: { select: { name: task.status } },
    Notes: {
      rich_text: task.notes ? [{ type: "text", text: { content: task.notes } }] : [],
    },
    Group: {
      rich_text: task.groupName ? [{ type: "text", text: { content: task.groupName } }] : [],
    },
    Updated: { date: { start: new Date(task.updatedAt).toISOString() } },
  };
}

// ---------------------------------------------------------------------------
// Retry (single retry on 429, honoring Retry-After)
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    await sleep(retryAfterMs(err));
    return fn();
  }
}

function isRateLimitError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 429;
}

function retryAfterMs(err: unknown): number {
  const headers = (err as { headers?: unknown }).headers;
  const parsed = parseRetryAfterHeader(headers);
  return parsed ?? DEFAULT_RETRY_DELAY_MS;
}

function parseRetryAfterHeader(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;

  let raw: string | null = null;
  if ("get" in headers && typeof (headers as { get: unknown }).get === "function") {
    raw = (headers as { get(name: string): string | null }).get("retry-after");
  } else {
    const record = headers as Record<string, string | undefined>;
    raw = record["retry-after"] ?? record["Retry-After"] ?? null;
  }

  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isNaN(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
