import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WhatsAppStore } from "../store.ts";
import type { WaMessageInput } from "../types.ts";
import type { NotionSync } from "../../notion/sync.ts";
import type { SyncResult, TaskForSync } from "../../notion/types.ts";
import {
  createExtractionSweep,
  runExtractionSweep,
  type SweepLogger,
} from "./sweep.ts";
import type { ExtractionRunner } from "./runner.ts";

function makeStore(): WhatsAppStore {
  return new WhatsAppStore(":memory:");
}

/** Total unprocessed messages left across every group — the sweep's per-group
 * selection means there's no single store-wide getter, so sum across groups. */
function unprocessedCount(store: WhatsAppStore): number {
  return store
    .getGroupsWithUnprocessed()
    .reduce(
      (n, jid) => n + store.getUnprocessedMessagesForGroup(jid, 10_000).length,
      0,
    );
}

function msg(overrides: Partial<WaMessageInput> = {}): WaMessageInput {
  return {
    id: "m1",
    groupJid: "g1@g.us",
    groupName: "Hermes Bangalore",
    senderJid: "alice@s.whatsapp.net",
    senderName: "Alice",
    ts: 1000,
    text: "hello",
    replyToId: null,
    raw: null,
    ...overrides,
  };
}

/** A logger that records everything, so tests can assert on warn/error paths. */
function recordingLogger(): SweepLogger & { infos: string[]; warns: string[]; errors: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warns,
    errors,
    info: (_t, m) => infos.push(m),
    warn: (_t, m) => warns.push(m),
    error: (_t, m) => errors.push(m),
  };
}

/** A runner that returns canned text; records the prompts it saw. */
function cannedRunner(output: string | ((prompt: string) => string)): ExtractionRunner & { prompts: string[] } {
  const prompts: string[] = [];
  const fn = (async (prompt: string) => {
    prompts.push(prompt);
    return typeof output === "function" ? output(prompt) : output;
  }) as ExtractionRunner & { prompts: string[] };
  fn.prompts = prompts;
  return fn;
}

/** A fake Notion sync: created rows get `page-<id>`; existing rows are "updated". */
function fakeNotion() {
  const synced: TaskForSync[][] = [];
  let ensured = 0;
  const notion: NotionSync = {
    async ensureTasksDatabase() {
      ensured += 1;
      return "db-1";
    },
    async syncTasks(tasks: TaskForSync[]): Promise<SyncResult> {
      synced.push(tasks);
      const created: Record<string, string> = {};
      const updated: string[] = [];
      for (const t of tasks) {
        if (t.notionPageId) updated.push(t.id);
        else created[t.id] = `page-${t.id}`;
      }
      return { created, updated, errors: [] };
    },
  };
  return {
    notion,
    synced,
    get ensuredCount() {
      return ensured;
    },
  };
}

describe("runExtractionSweep — applying ops", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("applies a create op and marks the group's messages processed", async () => {
    store.upsertMessage(msg({ id: "m1", text: "I'll build the login page" }));
    const runner = cannedRunner(
      '{"ops":[{"op":"create","task":"Build the login page","owner":"Alice","priority":"p1","sourceMsgId":"m1"}]}',
    );

    const result = await runExtractionSweep({
      store,
      runner,
      notionSync: null,
      logger: recordingLogger(),
    });

    const tasks = store.allTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      task: "Build the login page",
      owner: "Alice",
      priority: "p1",
      status: "open",
      groupJid: "g1@g.us",
      sourceMsgId: "m1",
    });
    expect(unprocessedCount(store)).toBe(0);
    expect(result.groupsProcessed).toBe(1);
    expect(result.tasksChanged).toBe(1);
  });

  test("applies an update op against an existing task", async () => {
    const task = store.createTask({ task: "Ship API", groupJid: "g1@g.us" });
    store.upsertMessage(msg({ id: "m2", text: "starting on the API now" }));
    const runner = cannedRunner(
      `{"ops":[{"op":"update","id":"${task.id}","status":"in-progress","priority":"p0"}]}`,
    );

    await runExtractionSweep({ store, runner, notionSync: null, logger: recordingLogger() });

    const updated = store.getTask(task.id);
    expect(updated?.status).toBe("in-progress");
    expect(updated?.priority).toBe("p0");
  });

  test("applies a complete op — sets status done and attaches the note", async () => {
    const task = store.createTask({ task: "Fix the bug", groupJid: "g1@g.us" });
    store.upsertMessage(msg({ id: "m3", text: "fixed, merged to main" }));
    const runner = cannedRunner(
      `{"ops":[{"op":"complete","id":"${task.id}","note":"merged to main"}]}`,
    );

    await runExtractionSweep({ store, runner, notionSync: null, logger: recordingLogger() });

    const done = store.getTask(task.id);
    expect(done?.status).toBe("done");
    expect(done?.notes).toBe("merged to main");
  });

  test("skips an op referencing an unknown task id but still processes the batch", async () => {
    store.upsertMessage(msg({ id: "m4" }));
    const logger = recordingLogger();
    const runner = cannedRunner(
      '{"ops":[{"op":"complete","id":"does-not-exist"},{"op":"create","task":"real task"}]}',
    );

    await runExtractionSweep({ store, runner, notionSync: null, logger });

    // The unknown-id op is rejected (it isn't in the group's open-task list
    // shown to the model), the create applies, batch consumed.
    expect(store.allTasks().map((t) => t.task)).toEqual(["real task"]);
    expect(unprocessedCount(store)).toBe(0);
    expect(logger.warns.some((w) => w.includes("outside this group's open-task list"))).toBe(true);
  });

  test("rejects update/complete ops that reference another group's task", async () => {
    // A real task in group g2 — its id is valid store-wide but must not be
    // reachable from a g1 extraction (model output is untrusted text).
    const foreign = store.createTask({
      task: "g2 task",
      groupJid: "g2@g.us",
      status: "open",
    });
    store.upsertMessage(msg({ id: "m5", groupJid: "g1@g.us", groupName: "Hermes One" }));
    const logger = recordingLogger();
    const runner = cannedRunner(
      `{"ops":[{"op":"complete","id":"${foreign.id}"}]}`,
    );

    await runExtractionSweep({ store, runner, notionSync: null, logger });

    expect(store.getTask(foreign.id)?.status).toBe("open"); // untouched
    expect(unprocessedCount(store)).toBe(0); // batch still consumed
    expect(logger.warns.some((w) => w.includes("outside this group's open-task list"))).toBe(true);
  });

  test("no unprocessed messages -> no runner call, empty result", async () => {
    const runner = cannedRunner('{"ops":[]}');
    const result = await runExtractionSweep({ store, runner, notionSync: null, logger: recordingLogger() });
    expect(runner.prompts).toHaveLength(0);
    expect(result.groupsProcessed).toBe(0);
  });

  test("groups messages by group_jid and prompts each group separately", async () => {
    store.upsertMessage(msg({ id: "a1", groupJid: "g1@g.us", groupName: "Hermes One", ts: 1 }));
    store.upsertMessage(msg({ id: "b1", groupJid: "g2@g.us", groupName: "Hermes Two", ts: 2 }));
    const runner = cannedRunner('{"ops":[]}');

    await runExtractionSweep({ store, runner, notionSync: null, logger: recordingLogger() });

    expect(runner.prompts).toHaveLength(2);
    expect(runner.prompts[0]).toContain("Hermes One");
    expect(runner.prompts[1]).toContain("Hermes Two");
  });
});

describe("runExtractionSweep — per-group selection", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("a perpetually-failing group does NOT starve the others", async () => {
    // g1 always fails extraction; g2 always succeeds. With global selection a
    // large stuck g1 batch could fill the batch and freeze g2 forever — per-group
    // selection visits g2 regardless.
    store.upsertMessage(msg({ id: "g1a", groupJid: "g1@g.us", groupName: "Hermes One", ts: 1 }));
    store.upsertMessage(msg({ id: "g2a", groupJid: "g2@g.us", groupName: "Hermes Two", ts: 2 }));

    const runner: ExtractionRunner = async (prompt) => {
      if (prompt.includes("Hermes One")) throw new Error("g1 always fails");
      return '{"ops":[{"op":"create","task":"g2 task"}]}';
    };

    const result = await runExtractionSweep({
      store,
      runner,
      notionSync: null,
      logger: recordingLogger(),
    });

    // g2 progressed despite g1 failing every time.
    expect(store.allTasks().map((t) => t.task)).toEqual(["g2 task"]);
    expect(store.getUnprocessedMessagesForGroup("g1@g.us", 10)).toHaveLength(1); // stuck
    expect(store.getUnprocessedMessagesForGroup("g2@g.us", 10)).toHaveLength(0); // drained
    expect(result.groupsProcessed).toBe(1);
    expect(result.parseFailures).toBe(1);
  });

  test("caps each group at messageLimit; the remainder is left for the next sweep", async () => {
    for (let i = 0; i < 5; i++) {
      store.upsertMessage(msg({ id: `m${i}`, groupJid: "g1@g.us", ts: 100 + i }));
    }
    const runner = cannedRunner('{"ops":[]}');

    // Per-group limit of 2 -> first sweep consumes 2, three remain.
    await runExtractionSweep({
      store,
      runner,
      notionSync: null,
      logger: recordingLogger(),
      messageLimit: 2,
    });
    expect(unprocessedCount(store)).toBe(3);

    // Next sweep consumes 2 more, then the last one.
    await runExtractionSweep({ store, runner, notionSync: null, logger: recordingLogger(), messageLimit: 2 });
    expect(unprocessedCount(store)).toBe(1);
    await runExtractionSweep({ store, runner, notionSync: null, logger: recordingLogger(), messageLimit: 2 });
    expect(unprocessedCount(store)).toBe(0);
  });
});

describe("runExtractionSweep — failure handling", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("runner failure leaves the group's messages unprocessed", async () => {
    store.upsertMessage(msg({ id: "m1" }));
    const logger = recordingLogger();
    const runner: ExtractionRunner = async () => {
      throw new Error("claude blew up");
    };

    const result = await runExtractionSweep({ store, runner, notionSync: null, logger });

    expect(unprocessedCount(store)).toBe(1); // still there
    expect(store.allTasks()).toHaveLength(0);
    expect(result.parseFailures).toBe(1);
    expect(logger.errors.some((e) => e.includes("runner failed"))).toBe(true);
  });

  test("parse failure (garbage output) leaves messages unprocessed", async () => {
    store.upsertMessage(msg({ id: "m1" }));
    const logger = recordingLogger();
    const runner = cannedRunner("this is not json");

    const result = await runExtractionSweep({ store, runner, notionSync: null, logger });

    expect(unprocessedCount(store)).toBe(1);
    expect(result.parseFailures).toBe(1);
    expect(logger.errors.some((e) => e.includes("parse failed"))).toBe(true);
  });

  test("a bad op inside a valid envelope is dropped; the batch is still consumed", async () => {
    store.upsertMessage(msg({ id: "m1" }));
    const runner = cannedRunner(
      '{"ops":[{"op":"create","task":"good"},{"op":"create","task":"bad","priority":"p9"}]}',
    );

    await runExtractionSweep({ store, runner, notionSync: null, logger: recordingLogger() });

    expect(store.allTasks().map((t) => t.task)).toEqual(["good"]);
    expect(unprocessedCount(store)).toBe(0); // consumed
  });
});

describe("runExtractionSweep — Notion sync", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("syncs changed tasks and persists created page ids", async () => {
    store.upsertMessage(msg({ id: "m1", text: "I'll do the deck" }));
    const runner = cannedRunner('{"ops":[{"op":"create","task":"Make the deck","owner":"Bo"}]}');
    const notion = fakeNotion();

    const result = await runExtractionSweep({
      store,
      runner,
      notionSync: notion.notion,
      logger: recordingLogger(),
      resolveGroupName: () => "Hermes Bangalore",
    });

    const task = store.allTasks()[0];
    expect(task.notionPageId).toBe(`page-${task.id}`);
    expect(notion.ensuredCount).toBe(1);
    expect(notion.synced[0][0]).toMatchObject({
      id: task.id,
      task: "Make the deck",
      owner: "Bo",
      groupName: "Hermes Bangalore",
    });
    expect(result.notionCreated).toBe(1);
  });

  test("also syncs pre-existing tasks whose notion_page_id is still null", async () => {
    // A task created by a prior sweep that never got synced (Notion was down).
    const orphan = store.createTask({ task: "Old unsynced task", groupJid: "g1@g.us" });
    store.upsertMessage(msg({ id: "m1", text: "unrelated chatter" }));
    const runner = cannedRunner('{"ops":[]}'); // no new ops this sweep
    const notion = fakeNotion();

    await runExtractionSweep({
      store,
      runner,
      notionSync: notion.notion,
      logger: recordingLogger(),
    });

    expect(store.getTask(orphan.id)?.notionPageId).toBe(`page-${orphan.id}`);
  });

  test("a task whose Notion update failed stays dirty and is retried on a later empty sweep", async () => {
    // A task already synced once: has a page id and is clean.
    const task = store.createTask({ task: "Ship API", groupJid: "g1@g.us" });
    store.setNotionPageId(task.id, "page-existing");
    expect(store.getTask(task.id)?.notionDirty).toBe(false);

    // A fake whose UPDATE calls fail until `failUpdates` is flipped off.
    let failUpdates = true;
    const notion: NotionSync = {
      async ensureTasksDatabase() {
        return "db-1";
      },
      async syncTasks(tasks: TaskForSync[]): Promise<SyncResult> {
        const created: Record<string, string> = {};
        const updated: string[] = [];
        const errors: { taskId: string; error: string }[] = [];
        for (const t of tasks) {
          if (t.notionPageId) {
            if (failUpdates) errors.push({ taskId: t.id, error: "notion 500" });
            else updated.push(t.id);
          } else {
            created[t.id] = `page-${t.id}`;
          }
        }
        return { created, updated, errors };
      },
    };

    // Sweep 1: a message drives an update op; the Notion UPDATE fails.
    store.upsertMessage(msg({ id: "m1", text: "starting the API" }));
    const runner1 = cannedRunner(
      `{"ops":[{"op":"update","id":"${task.id}","status":"in-progress"}]}`,
    );
    const r1 = await runExtractionSweep({
      store,
      runner: runner1,
      notionSync: notion,
      logger: recordingLogger(),
    });

    expect(r1.notionErrors).toBe(1);
    // Update failed -> row stays dirty; the message was still consumed.
    expect(store.getTask(task.id)?.notionDirty).toBe(true);
    expect(unprocessedCount(store)).toBe(0);

    // Sweep 2: NO new messages. Extraction phase skips, but the dirty task must
    // still reach the Notion phase and sync now that updates succeed.
    failUpdates = false;
    const runner2 = cannedRunner('{"ops":[]}');
    const r2 = await runExtractionSweep({
      store,
      runner: runner2,
      notionSync: notion,
      logger: recordingLogger(),
    });

    expect(runner2.prompts).toHaveLength(0); // extraction skipped — no messages
    expect(r2.notionUpdated).toBe(1);
    expect(store.getTask(task.id)?.notionDirty).toBe(false); // now in sync
  });

  test("Notion throwing does not crash the sweep; extraction state stays consistent", async () => {
    store.upsertMessage(msg({ id: "m1", text: "I'll do the deck" }));
    const runner = cannedRunner('{"ops":[{"op":"create","task":"Make the deck"}]}');
    const logger = recordingLogger();
    const brokenNotion: NotionSync = {
      async ensureTasksDatabase() {
        throw new Error("notion is down");
      },
      async syncTasks() {
        throw new Error("unreachable");
      },
    };

    const result = await runExtractionSweep({
      store,
      runner,
      notionSync: brokenNotion,
      logger,
    });

    // Task was still created + message consumed despite Notion failing.
    expect(store.allTasks()).toHaveLength(1);
    expect(unprocessedCount(store)).toBe(0);
    expect(result.tasksChanged).toBe(1);
    expect(logger.errors.some((e) => e.includes("notion sync failed"))).toBe(true);
  });
});

describe("runExtractionSweep — transactional apply (Fix 4)", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("an unexpected whole-group failure rolls back created tasks AND leaves messages unprocessed", () => {
    store.upsertMessage(msg({ id: "m1", text: "I'll build the login page" }));
    const runner = cannedRunner('{"ops":[{"op":"create","task":"Build the login page"}]}');
    const logger = recordingLogger();

    // Simulate a crash mid-commit: markProcessed throws AFTER the create op ran
    // inside the transaction. bun:sqlite must roll the whole group back.
    const realMarkProcessed = store.markProcessed.bind(store);
    store.markProcessed = () => {
      throw new Error("simulated crash before commit");
    };

    return runExtractionSweep({ store, runner, notionSync: null, logger }).then((result) => {
      store.markProcessed = realMarkProcessed;

      // Task creation rolled back, message never marked processed -> next sweep retries.
      expect(store.allTasks()).toHaveLength(0);
      expect(unprocessedCount(store)).toBe(1);
      expect(result.groupsProcessed).toBe(0);
      expect(result.tasksChanged).toBe(0);
      expect(result.parseFailures).toBe(1);
      expect(logger.errors.some((e) => e.includes("rolled back"))).toBe(true);
    });
  });

  test("per-op tolerance is preserved inside the transaction: one bad op skipped, the rest commit", async () => {
    store.upsertMessage(msg({ id: "m1" }));
    const logger = recordingLogger();
    // A complete op for an unreferencable id (logged, not thrown) alongside a good create.
    const runner = cannedRunner(
      '{"ops":[{"op":"complete","id":"nope"},{"op":"create","task":"real task"}]}',
    );

    await runExtractionSweep({ store, runner, notionSync: null, logger });

    expect(store.allTasks().map((t) => t.task)).toEqual(["real task"]);
    expect(unprocessedCount(store)).toBe(0); // committed
    expect(logger.warns.some((w) => w.includes("outside this group's open-task list"))).toBe(true);
  });
});

describe("runExtractionSweep — cross-sweep reply quotes (Fix 2)", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("a reply resolves its quote from an earlier sweep's (already processed) message", async () => {
    // Sweep 1 consumes the original message and marks it processed.
    store.upsertMessage(msg({ id: "m-old", text: "Ship the login page", ts: 1 }));
    await runExtractionSweep({
      store,
      runner: cannedRunner('{"ops":[{"op":"create","task":"Ship the login page"}]}'),
      notionSync: null,
      logger: recordingLogger(),
    });
    expect(unprocessedCount(store)).toBe(0);

    // Sweep 2: a "done" reply to that now-processed message. Its quote must still
    // resolve — via store.getMessage — even though m-old isn't in this batch.
    store.upsertMessage(msg({ id: "m2", text: "done", replyToId: "m-old", ts: 2 }));
    const runner2 = cannedRunner('{"ops":[]}');
    await runExtractionSweep({
      store,
      runner: runner2,
      notionSync: null,
      logger: recordingLogger(),
    });

    expect(runner2.prompts[0]).toContain("↳ replying to [m-old]: Ship the login page");
  });
});

describe("createExtractionSweep — re-entry guard", () => {
  let store: WhatsAppStore;
  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("a tick that fires while a sweep is running no-ops", async () => {
    store.upsertMessage(msg({ id: "m1" }));

    let releaseRunner: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let calls = 0;
    const runner: ExtractionRunner = async () => {
      calls += 1;
      await gate;
      return '{"ops":[]}';
    };
    const logger = recordingLogger();

    const sweep = createExtractionSweep({ store, runner, notionSync: null, logger });

    const first = sweep(); // starts, blocks inside the runner
    await sweep(); // re-entrant tick — must no-op immediately

    expect(calls).toBe(1);
    expect(logger.infos.some((i) => i.includes("still running"))).toBe(true);

    releaseRunner();
    await first;
    expect(calls).toBe(1);

    // After it settles, the guard has cleared — a fresh call with new work runs again.
    store.upsertMessage(msg({ id: "m2" }));
    await sweep();
    expect(calls).toBe(2);
  });
});
