import { resolveAgentManifest } from "../agents/registry.ts";
import { isPersistentAgent } from "../support/agents.ts";
import { isCapabilitySubset, isValidCapabilityBundle } from "./capabilities.ts";
import {
  HIGH_RISK_KINDS,
  RUNBOOK_INPUT_TYPES,
  RUNBOOK_RISKS,
  type RunbookDefinition,
  type RunbookRisk,
  type RunbookValidationError,
} from "./types.ts";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SECRET_PATTERNS = [
  /mongodb\+srv:\/\//i,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bghp_[A-Za-z0-9]{36,}/,
  /\bgho_[A-Za-z0-9]{36,}/,
  /password\s*[:=]\s*\S+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export function validateRunbook(
  def: RunbookDefinition,
  expectedFilename: string,
): RunbookValidationError[] {
  const errors: RunbookValidationError[] = [];

  if (def.schemaVersion !== 1) {
    errors.push({
      field: "schemaVersion",
      message: `expected 1, got ${def.schemaVersion}`,
    });
  }

  if (!def.name) {
    errors.push({ field: "name", message: "name is required" });
  } else if (!KEBAB_RE.test(def.name)) {
    errors.push({
      field: "name",
      message: `name must be kebab-case, got "${def.name}"`,
    });
  } else if (def.name !== expectedFilename) {
    errors.push({
      field: "name",
      message: `name "${def.name}" does not match filename "${expectedFilename}"`,
    });
  }

  if (!def.description) {
    errors.push({ field: "description", message: "description is required" });
  }

  if (!def.ownerAgent) {
    errors.push({ field: "ownerAgent", message: "ownerAgent is required" });
  } else if (!resolveAgentManifest(def.ownerAgent) && !isPersistentAgent(def.ownerAgent)) {
    errors.push({
      field: "ownerAgent",
      message: `ownerAgent "${def.ownerAgent}" not found in trusted catalog or identity registry`,
    });
  }

  if (!def.intent.examples || def.intent.examples.length === 0) {
    errors.push({
      field: "intent.examples",
      message: "at least one intent example is required",
    });
  }

  for (let i = 0; i < def.inputs.length; i++) {
    const input = def.inputs[i];
    if (!input.name) {
      errors.push({
        field: `inputs[${i}].name`,
        message: "input name is required",
      });
    }
    if (!RUNBOOK_INPUT_TYPES.includes(input.type)) {
      errors.push({
        field: `inputs[${i}].type`,
        message: `unknown input type "${input.type}"; allowed: ${RUNBOOK_INPUT_TYPES.join(", ")}`,
      });
    }
    if (input.type === "enum" && (!input.enumValues || input.enumValues.length === 0)) {
      errors.push({
        field: `inputs[${i}].enumValues`,
        message: `enum input "${input.name}" must declare enumValues`,
      });
    }
  }

  if (!RUNBOOK_RISKS.includes(def.risk)) {
    errors.push({
      field: "risk",
      message: `unknown risk "${def.risk}"; allowed: ${RUNBOOK_RISKS.join(", ")}`,
    });
  }

  if (
    HIGH_RISK_KINDS.includes(def.risk as RunbookRisk) &&
    !def.approval.required
  ) {
    errors.push({
      field: "approval.required",
      message: `risk "${def.risk}" requires approval.required = true`,
    });
  }

  if (def.risk !== "read-only" && !def.verification.required) {
    errors.push({
      field: "verification.required",
      message: `mutation risk "${def.risk}" requires verification.required = true`,
    });
  }

  for (const cap of def.capabilities) {
    if (!isValidCapabilityBundle(cap)) {
      errors.push({
        field: "capabilities",
        message: `unknown capability bundle "${cap}"`,
      });
    }
  }

  const validCaps = def.capabilities.filter(isValidCapabilityBundle);
  if (validCaps.length > 0 && def.ownerAgent) {
    const subset = isCapabilitySubset(validCaps, def.ownerAgent);
    if (!subset.ok) {
      for (const v of subset.violations) {
        errors.push({ field: "capabilities", message: v });
      }
    }
  }

  if (!def.prompt) {
    errors.push({ field: "prompt", message: "prompt body is required" });
  }

  const fullText = `${def.description}\n${def.prompt}\n${JSON.stringify(def.inputs)}`;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(fullText)) {
      errors.push({
        field: "content",
        message: `content matches secret pattern: ${pattern.source}`,
      });
    }
  }

  return errors;
}
