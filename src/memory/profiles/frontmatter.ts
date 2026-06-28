// Minimal frontmatter (de)serializer — by hand, no YAML dependency.
//
// Profiles are human-inspectable markdown (memory v3 §9), so the format is a
// `---` fenced block of `key: value` lines followed by a prose body. We only
// support the value shapes profiles actually use: strings, string arrays, and
// numbers. This is deliberately NOT a full YAML parser (CLAUDE.md: pure
// functions over framework ceremony) — it is small, total, and well-tested.
//
// Quoting strategy: a scalar/item is written bare when it round-trips cleanly;
// otherwise it is JSON-encoded (double quotes with standard escapes), which the
// parser detects by a leading `"` and decodes via JSON.parse. This makes quotes,
// commas, brackets, leading/trailing whitespace, and number-like strings safe.

export type FrontmatterValue = string | number | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseDocument(text: string): ParsedDocument {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: normalized.trim() };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // No closing fence — treat the whole document as body.
    return { frontmatter: {}, body: normalized.trim() };
  }

  const frontmatter: Frontmatter = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const match = /^([A-Za-z0-9_]+):\s?(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2].trim();
    frontmatter[key] = rawValue === "" ? "" : parseValue(rawValue);
  }

  const body = lines.slice(end + 1).join("\n").trim();
  return { frontmatter, body };
}

function parseValue(raw: string): FrontmatterValue {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return splitItems(inner).map((token) => String(parseScalarToken(token)));
  }
  return parseScalarToken(raw);
}

function parseScalarToken(token: string): string | number {
  const t = token.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Split a flow-array body on top-level commas, respecting double-quoted items. */
function splitItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      current += ch;
      if (ch === "\\") {
        current += inner[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inQuote = false;
      }
    } else if (ch === '"') {
      inQuote = true;
      current += ch;
    } else if (ch === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) items.push(current.trim());
  return items.filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push("---");
  const trimmedBody = body.trim();
  return lines.join("\n") + "\n" + (trimmedBody ? trimmedBody + "\n" : "");
}

function serializeValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[" + value.map(serializeArrayItem).join(", ") + "]";
  }
  if (typeof value === "number") return String(value);
  return serializeScalarString(value);
}

function serializeScalarString(s: string): string {
  const bareOk =
    s.length > 0 &&
    s.trim() === s &&
    !/[\n"]/.test(s) &&
    !s.startsWith("[") &&
    parseScalarToken(s) === s;
  return bareOk ? s : JSON.stringify(s);
}

function serializeArrayItem(s: string): string {
  const bareOk =
    s.length > 0 &&
    s.trim() === s &&
    !/[\n",[\]]/.test(s) &&
    parseScalarToken(s) === s;
  return bareOk ? s : JSON.stringify(s);
}
