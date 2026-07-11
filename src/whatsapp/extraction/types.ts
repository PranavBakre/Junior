// Task-extraction op types + validation (whatsapp-hermes-tracker §extraction sweep).
//
// The extraction model returns a JSON envelope `{ "ops": [...] }`. Each op is one
// of create / update / complete. We validate STRICTLY per-op with zod: an unknown
// op kind or an invalid enum value drops just that one op — never the whole batch
// — so a single malformed op the model hallucinated can't discard the good ops
// alongside it. A structurally-broken envelope (non-JSON, missing `ops` array)
// is a different failure: the sweep leaves those messages unprocessed to retry.

import { z } from "zod";

import { extractJsonObject } from "../../memory/consolidation/runner.ts";

const priorityEnum = z.enum(["p0", "p1", "p2"]);
const statusEnum = z.enum(["open", "in-progress", "done", "blocked"]);

/** New task inferred from group chatter. `task` is required and non-empty. */
export const createOpSchema = z.object({
  op: z.literal("create"),
  task: z.string().min(1),
  owner: z.string().optional(),
  priority: priorityEnum.optional(),
  status: statusEnum.optional(),
  notes: z.string().optional(),
  sourceMsgId: z.string().optional(),
});

/** Patch to an existing task (owner/priority/status/notes/text). `id` required. */
export const updateOpSchema = z.object({
  op: z.literal("update"),
  id: z.string().min(1),
  task: z.string().optional(),
  owner: z.string().optional(),
  priority: priorityEnum.optional(),
  status: statusEnum.optional(),
  notes: z.string().optional(),
});

/** A reply that closes a task ("done"/"shipped"/"fixed"). `id` required. */
export const completeOpSchema = z.object({
  op: z.literal("complete"),
  id: z.string().min(1),
  note: z.string().optional(),
});

export const taskOpSchema = z.discriminatedUnion("op", [
  createOpSchema,
  updateOpSchema,
  completeOpSchema,
]);

export type TaskOp = z.infer<typeof taskOpSchema>;
export type CreateTaskOp = z.infer<typeof createOpSchema>;
export type UpdateTaskOp = z.infer<typeof updateOpSchema>;
export type CompleteTaskOp = z.infer<typeof completeOpSchema>;

/**
 * Validate a raw list of ops, keeping only the well-formed ones. A per-op
 * validation failure (unknown op, bad enum, missing id) is silently dropped so
 * the rest of the batch survives — this is the "per-op, not per-batch" rule.
 */
export function validateOps(ops: unknown[]): TaskOp[] {
  const valid: TaskOp[] = [];
  for (const op of ops) {
    const result = taskOpSchema.safeParse(op);
    if (result.success) valid.push(result.data);
  }
  return valid;
}

/**
 * Parse the model's raw text into a validated op list.
 *
 * Throws on a STRUCTURAL failure (no JSON object, unparseable JSON, missing or
 * non-array `ops`) so the sweep can leave the group's messages unprocessed and
 * retry next tick. An empty `{ "ops": [] }` is the normal "nothing task-worthy"
 * case and returns `[]`. Individual malformed ops inside a valid envelope are
 * dropped by `validateOps`, not thrown.
 */
export function parseExtractionOutput(raw: string): TaskOp[] {
  const json = extractJsonObject(raw);
  if (!json) {
    throw new Error("extraction: model returned no JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`extraction: model output is not valid JSON (${reason})`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("extraction: model output is not a JSON object");
  }

  const opsRaw = (parsed as Record<string, unknown>).ops;
  if (opsRaw === undefined || opsRaw === null) {
    throw new Error('extraction: model output missing "ops" array');
  }
  if (!Array.isArray(opsRaw)) {
    throw new Error('extraction: "ops" must be an array');
  }

  return validateOps(opsRaw);
}
