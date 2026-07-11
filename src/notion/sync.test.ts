import { describe, expect, it } from "bun:test";

import { createNotionSync } from "./sync.ts";
import type { NotionApi } from "./client.ts";
import type { TaskForSync } from "./types.ts";

const PAGE_ID = "page-1";
const DB_TITLE = "Hermes Buildathon Tasks";

function noSleep(): Promise<void> {
  return Promise.resolve();
}

function baseTask(overrides: Partial<TaskForSync> = {}): TaskForSync {
  return {
    id: "task-1",
    task: "Pair Baileys",
    owner: "pranav",
    priority: "p0",
    status: "open",
    notes: null,
    groupName: "Hermes Core",
    notionPageId: null,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Minimal fake satisfying NotionApi, with call recording for assertions. */
function createFakeClient(overrides: Partial<NotionApi> = {}): {
  client: NotionApi;
  calls: {
    create: unknown[];
    update: unknown[];
    databasesCreate: unknown[];
    dataSourceQuery: unknown[];
    dataSourceUpdate: unknown[];
  };
} {
  const calls = {
    create: [] as unknown[],
    update: [] as unknown[],
    databasesCreate: [] as unknown[],
    dataSourceQuery: [] as unknown[],
    dataSourceUpdate: [] as unknown[],
  };

  const client: NotionApi = {
    blocks: {
      children: {
        list: async () => ({
          type: "block",
          block: {},
          object: "list",
          next_cursor: null,
          has_more: false,
          results: [],
        }),
      },
    },
    databases: {
      // An adopted (found) database is retrieved to resolve its data source id.
      retrieve: async () =>
        ({
          object: "database",
          id: "existing-db",
          data_sources: [{ id: "ds-existing", name: "default" }],
        }) as never,
      create: async (args) => {
        calls.databasesCreate.push(args);
        return {
          object: "database",
          id: "db-created",
          data_sources: [{ id: "ds-created", name: "default" }],
        } as never;
      },
    },
    dataSources: {
      // Default: no existing page matches the Task ID -> create path proceeds.
      query: async (args) => {
        calls.dataSourceQuery.push(args);
        return {
          type: "page_or_data_source",
          page_or_data_source: {},
          object: "list",
          next_cursor: null,
          has_more: false,
          results: [],
        } as never;
      },
      update: async (args) => {
        calls.dataSourceUpdate.push(args);
        return { object: "data_source", id: "ds-existing" } as never;
      },
    },
    pages: {
      create: async (args) => {
        calls.create.push(args);
        return { object: "page", id: "page-created" } as never;
      },
      update: async (args) => {
        calls.update.push(args);
        return { object: "page", id: "page-updated" } as never;
      },
    },
    ...overrides,
  };

  return { client, calls };
}

describe("ensureTasksDatabase", () => {
  it("creates a new database when no matching child_database block exists", async () => {
    const { client, calls } = createFakeClient();
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const id = await sync.ensureTasksDatabase();

    expect(id).toBe("db-created");
    expect(calls.databasesCreate).toHaveLength(1);
    const created = calls.databasesCreate[0] as { parent: { page_id: string }; title: unknown };
    expect(created.parent.page_id).toBe(PAGE_ID);
  });

  it("finds an existing child_database block titled 'Hermes Buildathon Tasks' instead of creating one", async () => {
    const { client, calls } = createFakeClient({
      blocks: {
        children: {
          list: async () => ({
            type: "block",
            block: {},
            object: "list",
            next_cursor: null,
            has_more: false,
            results: [
              { object: "block", id: "unrelated-page", type: "child_page", child_page: { title: "Other" } } as never,
              {
                object: "block",
                id: "existing-db",
                type: "child_database",
                child_database: { title: DB_TITLE },
              } as never,
            ],
          }),
        },
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const id = await sync.ensureTasksDatabase();

    expect(id).toBe("existing-db");
    expect(calls.databasesCreate).toHaveLength(0);
  });

  it("ignores a child_database block with a different title", async () => {
    const { client, calls } = createFakeClient({
      blocks: {
        children: {
          list: async () => ({
            type: "block",
            block: {},
            object: "list",
            next_cursor: null,
            has_more: false,
            results: [
              {
                object: "block",
                id: "other-db",
                type: "child_database",
                child_database: { title: "Some Other Database" },
              } as never,
            ],
          }),
        },
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const id = await sync.ensureTasksDatabase();

    expect(id).toBe("db-created");
    expect(calls.databasesCreate).toHaveLength(1);
  });

  it("paginates block children and finds the database on a later page", async () => {
    let listCalls = 0;
    const { client, calls } = createFakeClient({
      blocks: {
        children: {
          list: async (args) => {
            listCalls++;
            if (!args.start_cursor) {
              // Page 1: unrelated blocks, more to come.
              return {
                type: "block",
                block: {},
                object: "list",
                next_cursor: "cursor-2",
                has_more: true,
                results: [
                  {
                    object: "block",
                    id: "unrelated",
                    type: "child_page",
                    child_page: { title: "Other" },
                  } as never,
                ],
              };
            }
            // Page 2 (start_cursor === "cursor-2"): the tasks database.
            return {
              type: "block",
              block: {},
              object: "list",
              next_cursor: null,
              has_more: false,
              results: [
                {
                  object: "block",
                  id: "existing-db",
                  type: "child_database",
                  child_database: { title: DB_TITLE },
                } as never,
              ],
            };
          },
        },
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const id = await sync.ensureTasksDatabase();

    expect(id).toBe("existing-db");
    expect(listCalls).toBe(2);
    expect(calls.databasesCreate).toHaveLength(0);
  });

  it("caches the database id across calls (only looks it up once)", async () => {
    let listCalls = 0;
    const { client } = createFakeClient({
      blocks: {
        children: {
          list: async () => {
            listCalls++;
            return { type: "block", block: {}, object: "list", next_cursor: null, has_more: false, results: [] };
          },
        },
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    await sync.ensureTasksDatabase();
    await sync.ensureTasksDatabase();

    expect(listCalls).toBe(1);
  });
});

describe("syncTasks upsert partitioning", () => {
  it("creates a page for a task without notionPageId and reports it in created", async () => {
    const { client, calls } = createFakeClient();
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const result = await sync.syncTasks([baseTask({ id: "task-1", notionPageId: null })]);

    expect(calls.create).toHaveLength(1);
    expect(calls.update).toHaveLength(0);
    expect(result.created).toEqual({ "task-1": "page-created" });
    expect(result.updated).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("updates the existing page for a task with notionPageId and reports it in updated", async () => {
    const { client, calls } = createFakeClient();
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const result = await sync.syncTasks([baseTask({ id: "task-2", notionPageId: "existing-page-id" })]);

    expect(calls.update).toHaveLength(1);
    expect(calls.create).toHaveLength(0);
    const updateArgs = calls.update[0] as { page_id: string };
    expect(updateArgs.page_id).toBe("existing-page-id");
    expect(result.updated).toEqual(["task-2"]);
    expect(result.created).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it("partitions a mixed batch into created and updated", async () => {
    const { client } = createFakeClient();
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const result = await sync.syncTasks([
      baseTask({ id: "new-task", notionPageId: null }),
      baseTask({ id: "existing-task", notionPageId: "page-xyz" }),
    ]);

    expect(result.created).toEqual({ "new-task": "page-created" });
    expect(result.updated).toEqual(["existing-task"]);
    expect(result.errors).toEqual([]);
  });

  it("collects a per-task error without aborting the rest of the batch", async () => {
    const { client } = createFakeClient({
      pages: {
        create: async (args) => {
          const task = args as { properties: { Task: { title: Array<{ text: { content: string } }> } } };
          if (task.properties.Task.title[0]?.text.content === "boom") {
            throw new Error("validation_error: bad payload");
          }
          return { object: "page", id: "page-created" } as never;
        },
        update: async () => ({ object: "page", id: "page-updated" }) as never,
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const result = await sync.syncTasks([
      baseTask({ id: "bad-task", task: "boom", notionPageId: null }),
      baseTask({ id: "good-task", task: "fine", notionPageId: null }),
    ]);

    expect(result.errors).toEqual([{ taskId: "bad-task", error: "validation_error: bad payload" }]);
    expect(result.created).toEqual({ "good-task": "page-created" });
  });
});

describe("Task ID dedupe (crash-recovery)", () => {
  it("includes a Task ID property in a newly created database schema", async () => {
    const { client, calls } = createFakeClient();
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    await sync.ensureTasksDatabase();

    const created = calls.databasesCreate[0] as {
      initial_data_source: { properties: Record<string, unknown> };
    };
    expect(created.initial_data_source.properties).toHaveProperty("Task ID");
  });

  it("writes the task id into the Task ID property on create", async () => {
    const { client, calls } = createFakeClient();
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    await sync.syncTasks([baseTask({ id: "task-77", notionPageId: null })]);

    const createArgs = calls.create[0] as {
      properties: { "Task ID": { rich_text: Array<{ text: { content: string } }> } };
    };
    expect(createArgs.properties["Task ID"].rich_text[0]?.text.content).toBe("task-77");
  });

  it("writes the task id into the Task ID property on update", async () => {
    const { client, calls } = createFakeClient();
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    await sync.syncTasks([baseTask({ id: "task-88", notionPageId: "page-existing" })]);

    const updateArgs = calls.update[0] as {
      properties: { "Task ID": { rich_text: Array<{ text: { content: string } }> } };
    };
    expect(updateArgs.properties["Task ID"].rich_text[0]?.text.content).toBe("task-88");
  });

  it("create path finds an existing page by Task ID and updates it instead of duplicating", async () => {
    const { client, calls } = createFakeClient({
      dataSources: {
        query: async (args) => {
          calls.dataSourceQuery.push(args);
          // A page for this task already exists (id was never persisted locally).
          return {
            type: "page_or_data_source",
            page_or_data_source: {},
            object: "list",
            next_cursor: null,
            has_more: false,
            results: [{ object: "page", id: "recovered-page" }],
          } as never;
        },
        update: async () => ({ object: "data_source", id: "ds" }) as never,
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const result = await sync.syncTasks([baseTask({ id: "task-1", notionPageId: null })]);

    // No duplicate page created; the existing one is updated and reported under created.
    expect(calls.create).toHaveLength(0);
    expect(calls.update).toHaveLength(1);
    expect((calls.update[0] as { page_id: string }).page_id).toBe("recovered-page");
    expect(result.created).toEqual({ "task-1": "recovered-page" });
    expect(result.updated).toEqual([]);
  });

  it("fires onPageCreated for each create with the new page id", async () => {
    const { client } = createFakeClient();
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const fired: Array<[string, string]> = [];
    const result = await sync.syncTasks(
      [
        baseTask({ id: "a", notionPageId: null }),
        baseTask({ id: "b", notionPageId: "page-b" }), // update path — must NOT fire
      ],
      (taskId, pageId) => fired.push([taskId, pageId]),
    );

    expect(fired).toEqual([["a", "page-created"]]);
    expect(result.created).toEqual({ a: "page-created" });
    expect(result.updated).toEqual(["b"]);
  });

  it("fires onPageCreated for a Task-ID-recovered page too", async () => {
    const { client, calls } = createFakeClient({
      dataSources: {
        query: async () =>
          ({
            type: "page_or_data_source",
            page_or_data_source: {},
            object: "list",
            next_cursor: null,
            has_more: false,
            results: [{ object: "page", id: "recovered-page" }],
          }) as never,
        update: async () => ({ object: "data_source", id: "ds" }) as never,
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const fired: Array<[string, string]> = [];
    await sync.syncTasks([baseTask({ id: "task-1", notionPageId: null })], (t, p) =>
      fired.push([t, p]),
    );

    expect(fired).toEqual([["task-1", "recovered-page"]]);
    void calls;
  });

  it("adopts an existing database by adding the Task ID property to its data source", async () => {
    const { client, calls } = createFakeClient({
      blocks: {
        children: {
          list: async () => ({
            type: "block",
            block: {},
            object: "list",
            next_cursor: null,
            has_more: false,
            results: [
              {
                object: "block",
                id: "existing-db",
                type: "child_database",
                child_database: { title: DB_TITLE },
              } as never,
            ],
          }),
        },
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const id = await sync.ensureTasksDatabase();

    expect(id).toBe("existing-db");
    expect(calls.databasesCreate).toHaveLength(0);
    // The Task ID property is backfilled onto the adopted database's data source.
    expect(calls.dataSourceUpdate).toHaveLength(1);
    expect((calls.dataSourceUpdate[0] as { properties: Record<string, unknown> }).properties)
      .toHaveProperty("Task ID");
  });

  it("skips the pre-create lookup when dedupe could not be enabled", async () => {
    // A found database whose data source can't be resolved -> dedupe disabled.
    const { client, calls } = createFakeClient({
      blocks: {
        children: {
          list: async () => ({
            type: "block",
            block: {},
            object: "list",
            next_cursor: null,
            has_more: false,
            results: [
              {
                object: "block",
                id: "existing-db",
                type: "child_database",
                child_database: { title: DB_TITLE },
              } as never,
            ],
          }),
        },
      },
      databases: {
        // Partial response: no data_sources array -> no data source id.
        retrieve: async () => ({ object: "database", id: "existing-db" }) as never,
        create: async () => ({ object: "database", id: "db-created" }) as never,
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const result = await sync.syncTasks([baseTask({ id: "task-1", notionPageId: null })]);

    // No query attempted; falls straight through to create.
    expect(calls.dataSourceQuery).toHaveLength(0);
    expect(calls.create).toHaveLength(1);
    expect(result.created).toEqual({ "task-1": "page-created" });
  });
});

describe("429 retry", () => {
  it("retries once on 429 honoring Retry-After (seconds), then succeeds", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const { client } = createFakeClient({
      pages: {
        create: async () => {
          attempts++;
          if (attempts === 1) {
            const err = Object.assign(new Error("rate limited"), {
              status: 429,
              headers: { "retry-after": "2" },
            });
            throw err;
          }
          return { object: "page", id: "page-created-after-retry" } as never;
        },
        update: async () => ({ object: "page", id: "page-updated" }) as never,
      },
    });
    const sync = createNotionSync({
      token: "t",
      pageId: PAGE_ID,
      client,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await sync.syncTasks([baseTask({ id: "task-1", notionPageId: null })]);

    expect(attempts).toBe(2);
    expect(result.created).toEqual({ "task-1": "page-created-after-retry" });
    expect(result.errors).toEqual([]);
    // First sleep is the honored Retry-After (2s = 2000ms); second is the rate-limit pacing delay.
    expect(sleeps[0]).toBe(2000);
  });

  it("falls back to the default retry delay when Retry-After is absent", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const { client } = createFakeClient({
      pages: {
        create: async () => {
          attempts++;
          if (attempts === 1) {
            const err = Object.assign(new Error("rate limited"), { status: 429 });
            throw err;
          }
          return { object: "page", id: "page-created-after-retry" } as never;
        },
        update: async () => ({ object: "page", id: "page-updated" }) as never,
      },
    });
    const sync = createNotionSync({
      token: "t",
      pageId: PAGE_ID,
      client,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await sync.syncTasks([baseTask({ id: "task-1", notionPageId: null })]);

    expect(attempts).toBe(2);
    expect(result.created).toEqual({ "task-1": "page-created-after-retry" });
    expect(sleeps[0]).toBe(1000);
  });

  it("only retries once: a second consecutive 429 becomes a reported error", async () => {
    let attempts = 0;
    const { client } = createFakeClient({
      pages: {
        create: async () => {
          attempts++;
          const err = Object.assign(new Error("rate limited"), { status: 429 });
          throw err;
        },
        update: async () => ({ object: "page", id: "page-updated" }) as never,
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const result = await sync.syncTasks([baseTask({ id: "task-1", notionPageId: null })]);

    expect(attempts).toBe(2);
    expect(result.created).toEqual({});
    expect(result.errors).toEqual([{ taskId: "task-1", error: "rate limited" }]);
  });

  it("does not retry on non-429 errors", async () => {
    let attempts = 0;
    const { client } = createFakeClient({
      pages: {
        create: async () => {
          attempts++;
          const err = Object.assign(new Error("bad request"), { status: 400 });
          throw err;
        },
        update: async () => ({ object: "page", id: "page-updated" }) as never,
      },
    });
    const sync = createNotionSync({ token: "t", pageId: PAGE_ID, client, sleep: noSleep });

    const result = await sync.syncTasks([baseTask({ id: "task-1", notionPageId: null })]);

    expect(attempts).toBe(1);
    expect(result.errors).toEqual([{ taskId: "task-1", error: "bad request" }]);
  });
});
