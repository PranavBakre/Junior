import { log } from "../logger.ts";

type PipelineLogValue = string | number | boolean | null | undefined;

/** Emit a compact, searchable pipeline event without logging prompt contents. */
export function pipelineLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, PipelineLogValue>,
): void {
  const serialized = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${compact(value)}`)
    .join(" ");
  log[level]("pipeline", `event=${event}${serialized ? ` ${serialized}` : ""}`);
}

function compact(value: PipelineLogValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return String(value)
    .replace(/[\s=\r\n]+/g, "_")
    .slice(0, 500);
}
