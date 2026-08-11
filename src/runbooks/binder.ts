import type { RunbookDefinition } from "./types.ts";

export interface BoundInputs {
  bound: Record<string, string | number | boolean>;
  missing: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/;

export function bindInputs(
  runbook: RunbookDefinition,
  context: Record<string, string>,
): BoundInputs {
  const bound: Record<string, string | number | boolean> = {};
  const missing: string[] = [];

  const contextLower = new Map<string, string>();
  for (const [k, v] of Object.entries(context)) {
    contextLower.set(k.toLowerCase(), v);
  }

  for (const input of runbook.inputs) {
    const raw = contextLower.get(input.name.toLowerCase());

    if (raw === undefined || raw === "") {
      if (input.required) missing.push(input.name);
      continue;
    }

    const validated = validateAndCoerce(raw, input.type, input.enumValues);
    if (validated !== null) {
      bound[input.name] = validated;
    } else if (input.required) {
      missing.push(input.name);
    }
  }

  return { bound, missing };
}

function validateAndCoerce(
  raw: string,
  type: string,
  enumValues?: string[],
): string | number | boolean | null {
  switch (type) {
    case "string":
      return raw;
    case "email":
      return EMAIL_RE.test(raw) ? raw : null;
    case "objectId":
      return OBJECT_ID_RE.test(raw.toLowerCase()) ? raw.toLowerCase() : null;
    case "number": {
      const n = Number(raw);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      if (raw === "true" || raw === "1" || raw === "yes") return true;
      if (raw === "false" || raw === "0" || raw === "no") return false;
      return null;
    case "enum":
      return enumValues?.includes(raw) ? raw : null;
    default:
      return null;
  }
}

export function redactBoundInputs(
  bound: Record<string, string | number | boolean>,
  runbook: RunbookDefinition,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  const inputTypes = new Map(runbook.inputs.map((i) => [i.name, i.type]));

  for (const [key, value] of Object.entries(bound)) {
    const type = inputTypes.get(key);
    redacted[key] = redactValue(String(value), type ?? "string");
  }

  return redacted;
}

function redactValue(value: string, type: string): string {
  switch (type) {
    case "email": {
      const at = value.indexOf("@");
      if (at <= 1) return "***@***";
      return value[0] + "***@" + value.slice(at + 1);
    }
    case "objectId":
      return value.slice(0, 4) + "***" + value.slice(-4);
    default:
      return value;
  }
}
