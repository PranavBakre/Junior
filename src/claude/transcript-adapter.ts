import type { StreamEvent } from "./types.ts";

/**
 * One translated transcript line. Either we recognized it as a StreamEvent
 * the existing event pipeline understands, or we flagged it as the
 * turn-done signal, or we lifted a session id off it — or it's metadata
 * we ignore (returns null).
 */
export interface AdaptedLine {
  event: StreamEvent | null;
  sessionId: string | null;
  turnDone: boolean;
}

/**
 * Adapt one transcript JSONL line into a StreamEvent the rest of the
 * system understands.
 *
 * Transcript schema differs from `--output-format stream-json`:
 *
 *   - Each line carries extra envelope fields (`uuid`, `parentUuid`,
 *     `timestamp`, `cwd`, `gitBranch`, `sessionId`).
 *   - Many types are metadata-only (`last-prompt`, `permission-mode`,
 *     `ai-title`, `attachment`, `file-history-snapshot`, `pr-link`) and
 *     have no equivalent in stream-json. We drop them.
 *   - `system.subtype: "turn_duration"` is the turn-done signal — the
 *     interactive TUI's equivalent of a stream-json `result` event exit.
 *   - `system.subtype: "init"` carries the session id (same as stream-json).
 *   - `assistant.message.content` matches stream-json shape; the parser's
 *     existing extraction works unchanged.
 *
 * Anything we don't recognize is silently dropped — defensive against new
 * event types in future Claude Code versions.
 */
export function adaptTranscriptLine(line: string): AdaptedLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : null;

  // Turn boundary — the only line that ends a turn.
  if (type === "system" && obj.subtype === "turn_duration") {
    return { event: null, sessionId, turnDone: true };
  }

  // The stop_hook_summary event also lands at turn boundary; treat as a
  // redundancy check (don't double-resolve, but lift session id if needed).
  if (type === "system" && obj.subtype === "stop_hook_summary") {
    return { event: null, sessionId, turnDone: false };
  }

  // First system event after launch — equivalent to stream-json's `system.init`.
  // Carries `sessionId`, which we lift onto the synthesized init event.
  if (type === "system" && obj.subtype === "init") {
    if (!sessionId) return null;
    return {
      event: {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
      },
      sessionId,
      turnDone: false,
    };
  }

  // Assistant turn — the shape matches stream-json.
  if (type === "assistant" && typeof obj.message === "object" && obj.message !== null) {
    const msg = obj.message as Record<string, unknown>;
    if (!Array.isArray(msg.content)) return null;
    return {
      event: {
        type: "assistant",
        message: {
          role: "assistant",
          model: typeof msg.model === "string" ? msg.model : undefined,
          id: typeof msg.id === "string" ? msg.id : undefined,
          content: msg.content as StreamEvent extends { message: infer M }
            ? M extends { content: infer C }
              ? C
              : never
            : never,
        },
      } as StreamEvent,
      sessionId,
      turnDone: false,
    };
  }

  // User echo — match the existing parser's behavior (recognized but
  // content-free). Useful so the manager sees the same event shape as
  // stream-json.
  if (type === "user") {
    return { event: { type: "user" }, sessionId, turnDone: false };
  }

  // Everything else (last-prompt, permission-mode, ai-title, attachment,
  // file-history-snapshot, pr-link, system.* with other subtypes) is metadata
  // we don't surface to the rest of the system.
  return { event: null, sessionId, turnDone: false };
}
