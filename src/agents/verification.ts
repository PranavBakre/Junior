import type { JavaScriptPackageManager } from "../worktree/package-manager.ts";

/** Read-only repository and PR inspection available to every reviewer. */
const REVIEW_INSPECTION_COMMAND_PATTERNS = [
  "git status",
  "git status *",
  "git diff",
  "git diff *",
  "git show *",
  "git log *",
  "git rev-parse *",
  "git merge-base *",
  "git branch --show-current",
  "git ls-files *",
  "git fetch *",
  "gh pr view *",
  "gh pr diff *",
  "gh pr checks *",
  "gh pr checkout *",
] as const;

const VERIFICATION_SCRIPTS = [
  "test",
  "typecheck",
  "lint",
  "build",
  "check",
] as const;

/**
 * Build the shell allowlist for the package manager detected from the active
 * worktree. No repository names or organization-specific mappings belong in
 * this policy layer.
 */
export function worktreeVerificationCommandPatterns(
  packageManager: JavaScriptPackageManager,
): string[] {
  const commands: string[] = [...REVIEW_INSPECTION_COMMAND_PATTERNS];

  for (const script of VERIFICATION_SCRIPTS) {
    if (script === "test") {
      commands.push(`${packageManager} test`, `${packageManager} test *`);
    }
    commands.push(
      `${packageManager} run ${script}`,
      `${packageManager} run ${script} *`,
    );
    if (script === "test") {
      commands.push(
        `${packageManager} run test:*`,
        `${packageManager} run test:* *`,
      );
    }
  }

  return commands;
}
