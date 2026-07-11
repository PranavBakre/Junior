// Notion sync types (whatsapp-hermes-tracker §Notion sync, docs/features/whatsapp-hermes-tracker.md).
//
// SQLite (owned by src/whatsapp/) is the source of truth; this module only
// projects TaskForSync rows into the Notion database and reports back which
// pages were created/updated so the caller can persist notionPageId.

/** One SQLite task row, shaped for the Notion sync boundary. */
export interface TaskForSync {
  id: string;
  task: string;
  owner: string | null;
  priority: "p0" | "p1" | "p2" | null;
  status: "open" | "in-progress" | "done" | "blocked";
  notes: string | null;
  groupName: string | null;
  /** Notion page id from a prior sync, or null if this task has never been synced. */
  notionPageId: string | null;
  /** Epoch ms of the task's last local update. */
  updatedAt: number;
}

/** Result of one syncTasks() pass, for the caller to persist new page ids and report failures. */
export interface SyncResult {
  /** taskId -> newly created Notion page id. */
  created: Record<string, string>;
  /** taskIds whose existing Notion page was updated. */
  updated: string[];
  errors: { taskId: string; error: string }[];
}
