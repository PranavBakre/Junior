import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ResolvedSkillDefinition } from "./registry.ts";

export interface SkillRuntimePaths {
  root: string;
  claudeAddDir: string;
  openCodeConfigDir: string;
  openCodeSdkDir: string;
}

/**
 * Materialize provider-native discovery views for exactly one authorized
 * skill. The canonical SKILL.md remains under support/skills; generated
 * symlinks only adapt provider directory conventions.
 */
export function prepareSkillRuntime(
  skill: ResolvedSkillDefinition,
): SkillRuntimePaths {
  const root = resolve(
    import.meta.dirname ?? ".",
    `../../data/runtime-skills/${skill.name}`,
  );
  const packageDir = dirname(skill.path);
  const claudeLink = resolve(root, ".claude/skills", skill.name);
  const openCodeConfigDir = resolve(root, "opencode");
  const openCodeLink = resolve(openCodeConfigDir, "skills", skill.name);
  const openCodeSdkLink = resolve(root, ".opencode/skills", skill.name);

  ensureSymlink(claudeLink, packageDir);
  ensureSymlink(openCodeLink, packageDir);
  ensureSymlink(openCodeSdkLink, packageDir);

  return {
    root,
    claudeAddDir: root,
    openCodeConfigDir,
    openCodeSdkDir: root,
  };
}

export function skillInvocationPrompt(
  provider: "claude" | "opencode" | "codex",
  skill: ResolvedSkillDefinition,
  prompt: string,
): string {
  const body = prompt.trim();
  if (provider === "claude") return `/${skill.name} ${body}`.trim();
  if (provider === "codex") return `$${skill.name} ${body}`.trim();
  return [
    `Load the "${skill.name}" skill with OpenCode's native skill tool before proceeding.`,
    body,
  ].filter(Boolean).join("\n\n");
}

function ensureSymlink(linkPath: string, targetPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (
      stat.isSymbolicLink() &&
      resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath
    ) {
      return;
    }
    throw new Error(`skill runtime path already exists with unexpected target: ${linkPath}`);
  }
  try {
    symlinkSync(targetPath, linkPath, "dir");
  } catch (error) {
    // Two stateless assignments may materialize the same trusted skill at
    // once. The losing creator accepts the winner only when it is the exact
    // expected symlink.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST" &&
      existsSync(linkPath) &&
      lstatSync(linkPath).isSymbolicLink() &&
      resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath
    ) {
      return;
    }
    throw error;
  }
}
