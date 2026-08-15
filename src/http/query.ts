const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EPOCH_MS = /^\d+$/;

export function parseLimit(
  raw: string | null,
  fallback: number,
  max: number,
): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export function startOfLocalDay(date = new Date()): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfLocalDay(date = new Date()): number {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export type ParsedTimeBound =
  | { ok: true; value: number | undefined }
  | { ok: false };

export function parseTimeBound(
  raw: string | null,
  edge: "start" | "end",
): ParsedTimeBound {
  if (raw == null || raw === "") return { ok: true, value: undefined };
  if (DATE_ONLY.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      value: edge === "start" ? startOfLocalDay(date) : endOfLocalDay(date),
    };
  }
  if (EPOCH_MS.test(raw)) {
    return { ok: true, value: Number(raw) };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return { ok: false };
  return { ok: true, value: parsed };
}
