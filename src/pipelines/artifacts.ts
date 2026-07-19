/**
 * Pipeline-owned artifact writes. Agents may only write under
 * data/pipelines/<runId>/ or an assignment's explicitly registered artifact refs.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { Assignment } from "./types.ts";

export const PIPELINE_ARTIFACT_ROOT = "data/pipelines";

export type WriteArtifactInput = {
  runId: string;
  /** Relative path under the run directory, e.g. "spec.md" or "evidence/notes.md". */
  relativePath: string;
  content: string;
  /** Optional assignment whose artifactRefs may authorize alternate roots. */
  assignment?: Assignment | null;
  /** Project root (defaults to process.cwd()). */
  rootDir?: string;
};

export type WriteArtifactResult =
  | { ok: true; path: string; artifactRef: string }
  | { ok: false; reason: string };

/**
 * Resolve and validate a pipeline artifact path. Rejects path traversal and
 * writes outside pipeline-owned or assignment-registered roots.
 */
export function resolvePipelineArtifactPath(
  input: Omit<WriteArtifactInput, "content">,
): { ok: true; absPath: string; artifactRef: string } | { ok: false; reason: string } {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const runRoot = resolve(rootDir, PIPELINE_ARTIFACT_ROOT, input.runId);

  const rel = input.relativePath.replace(/^\/+/, "").trim();
  if (!rel) {
    return { ok: false, reason: "relativePath is required" };
  }
  if (rel.includes("\0") || rel.includes("..")) {
    return { ok: false, reason: "path traversal is not allowed" };
  }

  // Primary: under data/pipelines/<runId>/
  const candidate = resolve(runRoot, rel);
  if (isPathInside(runRoot, candidate)) {
    return {
      ok: true,
      absPath: candidate,
      artifactRef: `${PIPELINE_ARTIFACT_ROOT}/${input.runId}/${rel}`,
    };
  }

  // Secondary: assignment-registered absolute or project-relative refs.
  const assignment = input.assignment;
  if (assignment) {
    for (const ref of assignment.artifactRefs) {
      const refAbs = isAbsolute(ref) ? resolve(ref) : resolve(rootDir, ref);
      // If relativePath is under this registered ref directory:
      const underRef = resolve(refAbs, rel);
      if (isPathInside(refAbs, underRef) || underRef === refAbs) {
        return {
          ok: true,
          absPath: underRef,
          artifactRef: relative(rootDir, underRef).split(sep).join("/"),
        };
      }
      // Or if relativePath equals the registered ref itself:
      const normalizedRef = normalize(ref).replace(/^\.\/+/, "");
      if (rel === normalizedRef || rel === ref) {
        return {
          ok: true,
          absPath: refAbs,
          artifactRef: relative(rootDir, refAbs).split(sep).join("/"),
        };
      }
    }
  }

  return {
    ok: false,
    reason:
      "artifact path must be under data/pipelines/<runId>/ or an assignment-registered artifact ref",
  };
}

export async function writePipelineArtifact(
  input: WriteArtifactInput,
): Promise<WriteArtifactResult> {
  const resolved = resolvePipelineArtifactPath(input);
  if (!resolved.ok) return resolved;

  try {
    await mkdir(dirname(resolved.absPath), { recursive: true });
    await writeFile(resolved.absPath, input.content, "utf8");
    return {
      ok: true,
      path: resolved.absPath,
      artifactRef: resolved.artifactRef,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Allowlisted verification check stub. Records a check evidence artifact
 * without exposing arbitrary shell. Real runner integration lands later.
 */
export type RunCheckInput = {
  runId: string;
  assignmentId: string;
  checkName: string;
  /** Optional command name from the allowlist (recorded, not executed yet). */
  command?: string;
  status?: "passed" | "failed" | "skipped";
  stdout?: string;
  stderr?: string;
  rootDir?: string;
};

export type RunCheckResult =
  | {
      ok: true;
      check: {
        name: string;
        status: "passed" | "failed" | "skipped";
        evidenceRef: string;
        command?: string;
      };
    }
  | { ok: false; reason: string };

/** Hard allowlist of check names. Arbitrary shell is never exposed. */
export const ALLOWED_PIPELINE_CHECKS = [
  "typecheck",
  "unit-test",
  "lint",
  "build",
  "integration-test",
] as const;

export type AllowedPipelineCheck = (typeof ALLOWED_PIPELINE_CHECKS)[number];

export function isAllowedPipelineCheck(name: string): name is AllowedPipelineCheck {
  return (ALLOWED_PIPELINE_CHECKS as readonly string[]).includes(name);
}

export async function runPipelineCheck(
  input: RunCheckInput,
): Promise<RunCheckResult> {
  if (!isAllowedPipelineCheck(input.checkName)) {
    return {
      ok: false,
      reason: `check "${input.checkName}" is not allowlisted (allowed: ${ALLOWED_PIPELINE_CHECKS.join(", ")})`,
    };
  }

  const status = input.status ?? "skipped";
  const body = [
    `check: ${input.checkName}`,
    `status: ${status}`,
    `command: ${input.command ?? "(stub — no runner integration)"}`,
    `assignment_id: ${input.assignmentId}`,
    "",
    "--- stdout ---",
    input.stdout ?? "(none)",
    "",
    "--- stderr ---",
    input.stderr ?? "(none)",
    "",
  ].join("\n");

  const written = await writePipelineArtifact({
    runId: input.runId,
    relativePath: `checks/${input.checkName}-${Date.now()}.txt`,
    content: body,
    rootDir: input.rootDir,
  });

  if (!written.ok) {
    return { ok: false, reason: written.reason };
  }

  return {
    ok: true,
    check: {
      name: input.checkName,
      status,
      evidenceRef: written.artifactRef,
      ...(input.command ? { command: input.command } : {}),
    },
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
