import path from "node:path";

const LOG_DIR = path.resolve(import.meta.dir, "../../../logs");

interface LogEntry {
  timestamp: string;
  level: string;
  tag: string;
  message: string;
}

const LOG_LINE_RE = /^(.+?) \[(\w+)\] \[(.+?)\] (.*)$/;

/**
 * Strict ISO date matcher for the `?date=` query param. The value is concatenated
 * into a filesystem path (`<LOG_DIR>/<date>.log`), so anything other than a
 * literal YYYY-MM-DD string would let a caller escape `LOG_DIR` via traversal
 * (e.g. `?date=../../../etc/passwd`). Reject at the input layer rather than
 * trying to sanitize after the fact.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseLogLine(line: string): LogEntry | null {
  const match = line.match(LOG_LINE_RE);
  if (!match) return null;
  return {
    timestamp: match[1],
    level: match[2],
    tag: match[3],
    message: match[4],
  };
}

export async function handleLogs(searchParams: URLSearchParams): Promise<Response> {
  const date = searchParams.get("date") ?? new Date().toISOString().split("T")[0];
  if (!DATE_RE.test(date)) {
    return Response.json(
      { error: "invalid date — expected YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const tail = Number(searchParams.get("tail") ?? "50");
  const tag = searchParams.get("tag");
  const level = searchParams.get("level");

  const logFile = Bun.file(path.join(LOG_DIR, `${date}.log`));
  if (!(await logFile.exists())) {
    return Response.json({ date, entries: [] });
  }

  const content = await logFile.text();
  const lines = content.trim().split("\n").filter(Boolean);
  let entries = lines
    .map(parseLogLine)
    .filter((e): e is LogEntry => e !== null);

  if (tag) entries = entries.filter((e) => e.tag === tag);
  if (level) entries = entries.filter((e) => e.level === level);

  const sliced = tail > 0 ? entries.slice(-tail) : entries;

  return Response.json({ date, entries: sliced });
}
