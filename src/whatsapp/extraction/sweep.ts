// Extraction sweep (whatsapp-hermes-tracker §extraction sweep).
//
// One offline pass over the unprocessed WhatsApp messages. Selection is
// per-group: iterate every group that has pending messages and pull a bounded
// per-group batch, rather than the globally-oldest N. That way a group whose
// runner/parse keeps failing (and so never advances) can only ever hold up its
// own messages — it can't fill a shared global batch and starve every other
// group forever. The per-group cap also bounds each prompt's size, which keeps
// it clear of the runner's argv/stdin limits.
//
// For each group: build an extraction prompt from that group's batch + open
// tasks, run the model, validate the returned ops, and apply them to the SQLite
// store (the source of truth). Only the messages actually included in a group's
// prompt are marked processed, and only when that group parsed + applied cleanly
// — a runner/parse failure (or any remainder past the cap) leaves messages for
// the next sweep. After all groups, changed tasks (plus any never-synced task)
// are diff-synced to Notion, and the returned page ids are persisted back onto
// the SQLite rows.

import type { NotionSync } from "../../notion/sync.ts";
import type { TaskForSync } from "../../notion/types.ts";
import type {
  CreateWaTaskInput,
  UpdateWaTaskInput,
  WaMessage,
  WaTask,
} from "../types.ts";
import { buildExtractionPrompt } from "./prompt.ts";
import type { ExtractionRunner } from "./runner.ts";
import { parseExtractionOutput, type TaskOp } from "./types.ts";

/** Narrow store surface the sweep needs — `WhatsAppStore` satisfies it. */
export interface ExtractionStore {
  getGroupsWithUnprocessed(): string[];
  getUnprocessedMessagesForGroup(groupJid: string, limit: number): WaMessage[];
  getMessage(id: string): WaMessage | undefined;
  markProcessed(ids: string[]): void;
  createTask(input: CreateWaTaskInput): WaTask;
  updateTask(id: string, patch: UpdateWaTaskInput): WaTask | undefined;
  getOpenTasks(groupJid?: string): WaTask[];
  setNotionPageId(taskId: string, pageId: string): void;
  markNotionSynced(taskIds: string[]): void;
  allTasks(): WaTask[];
  runInTransaction<T>(fn: () => T): T;
}

/** Minimal logger surface (the app's `log` satisfies it). */
export interface SweepLogger {
  info(tag: string, message: string): void;
  warn(tag: string, message: string): void;
  error(tag: string, message: string): void;
}

export interface ExtractionSweepDeps {
  store: ExtractionStore;
  /** prompt -> raw model text. Inject a fake in tests; production spawns claude. */
  runner: ExtractionRunner;
  /** Notion sync, or null when NOTION_TOKEN is unset (extraction still runs). */
  notionSync: NotionSync | null;
  logger: SweepLogger;
  /** Resolve a group JID to a subject for the Notion `Group` column, where known. */
  resolveGroupName?: (groupJid: string) => string | undefined;
  /**
   * Max messages pulled PER GROUP per sweep (default 150). Bounds each prompt's
   * size and caps how much any single group advances per pass; anything over the
   * cap is left for the next sweep. Not a global batch size — every group with
   * pending messages is visited each sweep.
   */
  messageLimit?: number;
}

export interface ExtractionSweepResult {
  groupsProcessed: number;
  messagesProcessed: number;
  tasksChanged: number;
  parseFailures: number;
  notionCreated: number;
  notionUpdated: number;
  notionErrors: number;
}

/** Per-group message cap for one sweep (see `messageLimit`). */
const DEFAULT_PER_GROUP_LIMIT = 150;
const LOG_TAG = "whatsapp";

/**
 * Run one extraction pass. Does NOT guard against concurrent invocation — wrap
 * it with `createExtractionSweep` for `setInterval` use. Never throws for Notion
 * failures (they're caught and logged); a per-group runner/parse failure just
 * leaves that group's messages unprocessed.
 */
export async function runExtractionSweep(
  deps: ExtractionSweepDeps,
): Promise<ExtractionSweepResult> {
  const { store, runner, notionSync, logger } = deps;
  const perGroupLimit = deps.messageLimit ?? DEFAULT_PER_GROUP_LIMIT;

  const result: ExtractionSweepResult = {
    groupsProcessed: 0,
    messagesProcessed: 0,
    tasksChanged: 0,
    parseFailures: 0,
    notionCreated: 0,
    notionUpdated: 0,
    notionErrors: 0,
  };

  // Not returning early on zero messages: a task whose prior Notion write failed
  // stays dirty and must still get retried in the Notion phase below, even on a
  // sweep with no new messages. The extraction loop simply skips (no groups).
  const groupJids = store.getGroupsWithUnprocessed();
  const changedTaskIds = new Set<string>();

  for (const groupJid of groupJids) {
    // Bounded per-group batch. A remainder past the cap is naturally picked up
    // by the next sweep — and because selection is per-group, that remainder
    // (or a group that keeps failing below) can never starve the other groups.
    const groupMessages = store.getUnprocessedMessagesForGroup(
      groupJid,
      perGroupLimit,
    );
    if (groupMessages.length === 0) continue;

    const openTasks = store.getOpenTasks(groupJid);
    const groupName = groupMessages[0]?.groupName ?? groupJid;
    const prompt = buildExtractionPrompt({
      groupName,
      openTasks,
      messages: groupMessages,
      // Resolve a reply's quoted message that fell outside this batch (consumed
      // by an earlier sweep) so reply-marks-done works across sweep boundaries.
      resolveQuote: (id) => {
        const quoted = store.getMessage(id);
        return quoted && quoted.text
          ? { id: quoted.id, text: quoted.text }
          : undefined;
      },
    });

    let raw: string;
    try {
      raw = await runner(prompt);
    } catch (err) {
      // Runner failure: leave this group's messages unprocessed for next sweep.
      logger.error(
        LOG_TAG,
        `extraction runner failed for group ${groupName}: ${errMsg(err)} — leaving ${groupMessages.length} messages unprocessed`,
      );
      result.parseFailures += 1;
      continue;
    }

    let ops: TaskOp[];
    try {
      ops = parseExtractionOutput(raw);
    } catch (err) {
      // Parse failure: same — leave unprocessed and retry.
      logger.error(
        LOG_TAG,
        `extraction parse failed for group ${groupName}: ${errMsg(err)} — leaving ${groupMessages.length} messages unprocessed`,
      );
      result.parseFailures += 1;
      continue;
    }

    // Apply the batch's ops AND mark its messages processed as ONE transaction,
    // so a crash between the two can't leave tasks applied but messages still
    // unprocessed (which would re-extract and duplicate them next boot). Ops are
    // buffered into a local `changed` set and only merged into the sweep-wide set
    // once the transaction commits, so a rolled-back group reports no changes.
    // The per-op catch stays INSIDE the transaction: a single bad op is skipped
    // (documented tolerance) while the rest commit; only an unexpected
    // whole-group failure escapes and rolls the group back.
    // The only task ids the model may legitimately reference are the ones we
    // showed it — this group's open tasks. The model reasons over UNTRUSTED
    // group text, so a valid-looking id pointing at another group's task must
    // be rejected, not applied globally.
    const referencableIds = new Set(openTasks.map((t) => t.id));
    const groupChanged = new Set<string>();
    try {
      store.runInTransaction(() => {
        for (const op of ops) {
          try {
            applyOp(store, op, groupJid, referencableIds, groupChanged, logger);
          } catch (err) {
            // A single op failing to apply must not discard the rest of the batch.
            logger.warn(
              LOG_TAG,
              `skipped op (${op.op}) in group ${groupName}: ${errMsg(err)}`,
            );
          }
        }
        // Mark ONLY the messages that went into this group's prompt as consumed;
        // any remainder past the cap stays for the next sweep.
        store.markProcessed(groupMessages.map((m) => m.id));
      });
    } catch (err) {
      // Unexpected whole-group failure — the transaction rolled back, so this
      // group's tasks are undone and its messages stay unprocessed for retry.
      logger.error(
        LOG_TAG,
        `extraction apply failed for group ${groupName}: ${errMsg(err)} — rolled back, leaving ${groupMessages.length} messages unprocessed`,
      );
      result.parseFailures += 1;
      continue;
    }

    for (const id of groupChanged) changedTaskIds.add(id);
    result.groupsProcessed += 1;
    result.messagesProcessed += groupMessages.length;
  }

  result.tasksChanged = changedTaskIds.size;

  if (notionSync) {
    await syncToNotion(deps, result);
  }

  return result;
}

/**
 * Wrap `runExtractionSweep` with an in-flight flag so it is safe to call from
 * `setInterval`: a tick that fires while the previous sweep is still running
 * no-ops instead of overlapping (double-processing / double Notion writes).
 */
export function createExtractionSweep(
  deps: ExtractionSweepDeps,
): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      deps.logger.info(
        LOG_TAG,
        "extraction sweep still running — skipping this tick",
      );
      return;
    }
    inFlight = true;
    try {
      await runExtractionSweep(deps);
    } catch (err) {
      // Safety net — runExtractionSweep already swallows Notion errors.
      deps.logger.error(LOG_TAG, `extraction sweep crashed: ${errMsg(err)}`);
    } finally {
      inFlight = false;
    }
  };
}

function applyOp(
  store: ExtractionStore,
  op: TaskOp,
  groupJid: string,
  referencableIds: Set<string>,
  changed: Set<string>,
  logger: SweepLogger,
): void {
  if (op.op === "create") {
    const task = store.createTask({
      task: op.task,
      owner: op.owner ?? null,
      priority: op.priority ?? null,
      status: op.status ?? "open",
      notes: op.notes ?? null,
      groupJid,
      sourceMsgId: op.sourceMsgId ?? null,
    });
    changed.add(task.id);
    return;
  }

  // update/complete may only touch tasks that were in this group's open-task
  // list shown to the model — anything else (another group's task, a done
  // task, a hallucinated-but-colliding id) is rejected.
  if (!referencableIds.has(op.id)) {
    logger.warn(
      LOG_TAG,
      `${op.op} op referenced task id ${op.id} outside this group's open-task list — rejected`,
    );
    return;
  }

  if (op.op === "update") {
    const patch: UpdateWaTaskInput = {};
    if (op.task !== undefined) patch.task = op.task;
    if (op.owner !== undefined) patch.owner = op.owner;
    if (op.priority !== undefined) patch.priority = op.priority;
    if (op.status !== undefined) patch.status = op.status;
    if (op.notes !== undefined) patch.notes = op.notes;
    const updated = store.updateTask(op.id, patch);
    if (updated) {
      changed.add(op.id);
    } else {
      logger.warn(LOG_TAG, `update op referenced unknown task id ${op.id}`);
    }
    return;
  }

  // complete: mark done, attaching the closing note if provided.
  const patch: UpdateWaTaskInput = { status: "done" };
  if (op.note !== undefined) patch.notes = op.note;
  const completed = store.updateTask(op.id, patch);
  if (completed) {
    changed.add(op.id);
  } else {
    logger.warn(LOG_TAG, `complete op referenced unknown task id ${op.id}`);
  }
}

/**
 * Diff-sync every dirty (or never-synced) task to Notion, then persist the
 * outcome: created rows get their page id (which clears dirty), updated rows are
 * marked synced, and rows that errored stay dirty for the next sweep to retry.
 * Notion failures are logged, never thrown — the SQLite extraction state stays
 * consistent regardless.
 */
async function syncToNotion(
  deps: ExtractionSweepDeps,
  result: ExtractionSweepResult,
): Promise<void> {
  const { store, notionSync, logger, resolveGroupName } = deps;
  if (!notionSync) return;

  try {
    await notionSync.ensureTasksDatabase();

    // Dirty flag is the sync selector: any row with local changes not yet in
    // Notion (including a prior transient update failure) plus any never-synced
    // row. A task whose UPDATE failed keeps notion_dirty=1 and is retried here.
    const toSync = store
      .allTasks()
      .filter((t) => t.notionDirty || t.notionPageId === null)
      .map((t) => toTaskForSync(t, resolveGroupName));

    if (toSync.length === 0) return;

    // Persist each new page id the instant its create returns, not after the
    // whole batch — a crash mid-batch would otherwise leave a created page with
    // no id recorded, and the next sweep would create a DUPLICATE Notion page.
    const syncResult = await notionSync.syncTasks(toSync, (taskId, pageId) => {
      store.setNotionPageId(taskId, pageId);
    });

    // Belt-and-suspenders: the callback above already persisted these, but
    // re-applying is idempotent and covers a syncTasks impl that skips it.
    for (const [taskId, pageId] of Object.entries(syncResult.created)) {
      store.setNotionPageId(taskId, pageId);
    }
    // Updated rows landed cleanly — clear their dirty flag. Rows in
    // syncResult.errors are deliberately left dirty for the next sweep.
    store.markNotionSynced(syncResult.updated);

    result.notionCreated = Object.keys(syncResult.created).length;
    result.notionUpdated = syncResult.updated.length;
    result.notionErrors = syncResult.errors.length;

    if (syncResult.errors.length > 0) {
      logger.warn(
        LOG_TAG,
        `notion sync reported ${syncResult.errors.length} row error(s): ${syncResult.errors
          .map((e) => `${e.taskId}:${e.error}`)
          .join("; ")}`,
      );
    }
  } catch (err) {
    logger.error(LOG_TAG, `notion sync failed: ${errMsg(err)}`);
  }
}

function toTaskForSync(
  task: WaTask,
  resolveGroupName?: (groupJid: string) => string | undefined,
): TaskForSync {
  const groupName = task.groupJid
    ? (resolveGroupName?.(task.groupJid) ?? null)
    : null;
  return {
    id: task.id,
    task: task.task,
    owner: task.owner,
    priority: task.priority,
    status: task.status,
    notes: task.notes,
    groupName,
    notionPageId: task.notionPageId,
    updatedAt: task.updatedAt,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
