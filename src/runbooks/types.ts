export interface RunbookInput {
  name: string;
  type: RunbookInputType;
  required: boolean;
  enumValues?: string[];
  description?: string;
}

export type RunbookInputType =
  | "string"
  | "email"
  | "objectId"
  | "number"
  | "boolean"
  | "enum";

export const RUNBOOK_INPUT_TYPES: readonly RunbookInputType[] = [
  "string",
  "email",
  "objectId",
  "number",
  "boolean",
  "enum",
];

export type RunbookRisk =
  | "read-only"
  | "workspace-write"
  | "production-write"
  | "destructive"
  | "credential"
  | "privacy-sensitive"
  | "payment"
  | "access-control";

export const RUNBOOK_RISKS: readonly RunbookRisk[] = [
  "read-only",
  "workspace-write",
  "production-write",
  "destructive",
  "credential",
  "privacy-sensitive",
  "payment",
  "access-control",
];

export const HIGH_RISK_KINDS: readonly RunbookRisk[] = [
  "production-write",
  "destructive",
  "credential",
  "privacy-sensitive",
  "payment",
  "access-control",
];

export interface RunbookApproval {
  required: boolean;
  afterSteps?: string[];
}

export interface RunbookVerification {
  required: boolean;
  assertions: string[];
}

export interface RunbookDefinition {
  schemaVersion: number;
  name: string;
  description: string;
  ownerAgent: string;
  intent: {
    examples: string[];
    excludes: string[];
  };
  inputs: RunbookInput[];
  risk: RunbookRisk;
  approval: RunbookApproval;
  capabilities: string[];
  verification: RunbookVerification;
  tags: string[];
  prompt: string;
  filePath: string;
  origin: "private" | "public";
  contentDigest: string;
}

export interface RunbookValidationError {
  field: string;
  message: string;
}

export type RunbookLoadResult =
  | { ok: true; definition: RunbookDefinition }
  | { ok: false; errors: RunbookValidationError[]; filePath: string };
