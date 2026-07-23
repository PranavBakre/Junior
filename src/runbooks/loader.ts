import type { RunbookDefinition, RunbookLoadResult } from "./types.ts";
import { validateRunbook } from "./validator.ts";

export async function loadRunbookDefinition(
  filePath: string,
  options?: { origin?: "private" | "public"; filenameForValidation?: string },
): Promise<RunbookLoadResult> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {
      ok: false,
      errors: [{ field: "file", message: `file not found: ${filePath}` }],
      filePath,
    };
  }

  const raw = await file.text();
  const contentDigest = computeDigest(raw);
  const { frontmatter, body } = extractFrontmatter(raw);

  if (!frontmatter) {
    return {
      ok: false,
      errors: [{ field: "frontmatter", message: "missing YAML frontmatter" }],
      filePath,
    };
  }

  const parsed = parseYamlFrontmatter(frontmatter);
  const origin = options?.origin ?? "private";

  const definition: RunbookDefinition = {
    schemaVersion: toNumber(parsed.schemaVersion) ?? 0,
    name: toString(parsed.name) ?? "",
    description: toString(parsed.description) ?? "",
    ownerAgent: toString(parsed.ownerAgent) ?? "",
    intent: {
      examples: toStringArray(parsed.intent?.examples) ?? [],
      excludes: toStringArray(parsed.intent?.excludes) ?? [],
    },
    inputs: toInputArray(parsed.inputs),
    risk: toString(parsed.risk) as RunbookDefinition["risk"],
    approval: {
      required: toBool(parsed.approval?.required) ?? false,
      afterSteps: toStringArray(parsed.approval?.afterSteps),
    },
    capabilities: toStringArray(parsed.capabilities) ?? [],
    verification: {
      required: toBool(parsed.verification?.required) ?? false,
      assertions: toStringArray(parsed.verification?.assertions) ?? [],
    },
    tags: toStringArray(parsed.tags) ?? [],
    prompt: body.trim(),
    filePath,
    origin,
    contentDigest,
  };

  const filename = options?.filenameForValidation ?? filenameStem(filePath);
  const errors = validateRunbook(definition, filename);

  if (errors.length > 0) {
    return { ok: false, errors, filePath };
  }

  return { ok: true, definition };
}

function computeDigest(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

function filenameStem(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  return base.replace(/\.runbook\.md$/, "");
}

function extractFrontmatter(raw: string): {
  frontmatter: string | null;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { frontmatter: null, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: null, body: raw };
  }
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 4);
  return { frontmatter: fm, body };
}

// ─── minimal nested YAML parser ─────────────────────────────────────────────
//
// Handles the subset of YAML used by runbook frontmatter:
// - scalar key: value
// - nested objects (indented keys)
// - arrays of scalars (- item)
// - arrays of objects (- name: foo\n  type: bar)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YamlNode = Record<string, any>;

function parseYamlFrontmatter(text: string): YamlNode {
  const lines = text.split("\n");
  return parseBlock(lines, 0, 0).node;
}

function parseBlock(
  lines: string[],
  start: number,
  baseIndent: number,
): { node: YamlNode; nextLine: number } {
  const node: YamlNode = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = countIndent(line);
    if (indent < baseIndent) break;

    const trimmed = line.trim();

    if (trimmed.startsWith("- ")) {
      break;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const valueStr = trimmed.slice(colonIdx + 1).trim();

    if (valueStr === "") {
      const nextIndent = peekIndent(lines, i + 1);
      if (nextIndent > indent) {
        const nextTrimmed = lines[i + 1]?.trim() ?? "";
        if (nextTrimmed.startsWith("- ")) {
          const arr = parseArray(lines, i + 1, nextIndent);
          node[key] = arr.items;
          i = arr.nextLine;
        } else {
          const sub = parseBlock(lines, i + 1, nextIndent);
          node[key] = sub.node;
          i = sub.nextLine;
        }
      } else {
        node[key] = "";
        i++;
      }
    } else {
      node[key] = parseScalar(valueStr);
      i++;
    }
  }

  return { node, nextLine: i };
}

function parseArray(
  lines: string[],
  start: number,
  baseIndent: number,
): { items: (string | YamlNode)[]; nextLine: number } {
  const items: (string | YamlNode)[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = countIndent(line);
    if (indent < baseIndent) break;

    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) break;

    const value = trimmed.slice(2).trim();
    const colonIdx = value.indexOf(":");
    if (colonIdx !== -1 && value.slice(colonIdx + 1).trim() !== "") {
      // Only treat as object if continuation keys follow at indent+2
      const contIndent = indent + 2;
      const nextContentIdx = nextNonBlankLine(lines, i + 1);
      const hasCont =
        nextContentIdx !== -1 &&
        countIndent(lines[nextContentIdx]) >= contIndent &&
        !lines[nextContentIdx].trim().startsWith("- ");

      if (hasCont) {
        const obj: YamlNode = {};
        const objKey = value.slice(0, colonIdx).trim();
        const objVal = value.slice(colonIdx + 1).trim();
        obj[objKey] = parseScalar(objVal);

        i++;
        while (i < lines.length) {
          const contLine = lines[i];
          if (contLine.trim() === "") {
            i++;
            continue;
          }
          const ci = countIndent(contLine);
          if (ci < contIndent) break;
          const ct = contLine.trim();
          const cc = ct.indexOf(":");
          if (cc === -1 || ct.startsWith("- ")) break;
          obj[ct.slice(0, cc).trim()] = parseScalar(ct.slice(cc + 1).trim());
          i++;
        }
        items.push(obj);
      } else {
        items.push(value);
        i++;
      }
    } else if (colonIdx !== -1 && value.slice(colonIdx + 1).trim() === "") {
      // Array item with nested object: - key:\n    subkey: val
      const obj: YamlNode = {};
      const objKey = value.slice(0, colonIdx).trim();
      i++;
      const nestedIndent = peekIndent(lines, i);
      if (nestedIndent > indent) {
        const sub = parseBlock(lines, i, nestedIndent);
        obj[objKey] = sub.node;
        i = sub.nextLine;
      } else {
        obj[objKey] = "";
      }
      items.push(obj);
    } else {
      items.push(parseScalar(value) as string);
      i++;
    }
  }

  return { items, nextLine: i };
}

function parseScalar(s: string): string | number | boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  // Strip surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  const n = Number(s);
  if (!Number.isNaN(n) && s !== "") return n;
  return s;
}

function countIndent(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else break;
  }
  return n;
}

function nextNonBlankLine(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t !== "" && !t.startsWith("#")) return i;
  }
  return -1;
}

function peekIndent(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t !== "" && !t.startsWith("#")) return countIndent(lines[i]);
  }
  return 0;
}

// ─── type coercions ─────────────────────────────────────────────────────────

function toString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function toBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((item) => (typeof item === "string" ? item : String(item)));
}

function toInputArray(v: unknown): RunbookDefinition["inputs"] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is YamlNode => typeof item === "object" && item !== null)
    .map((item) => ({
      name: toString(item.name) ?? "",
      type: (toString(item.type) ?? "string") as RunbookDefinition["inputs"][number]["type"],
      required: toBool(item.required) ?? false,
      ...(item.enumValues
        ? { enumValues: toStringArray(item.enumValues) }
        : {}),
      ...(item.description ? { description: toString(item.description) } : {}),
    }));
}
