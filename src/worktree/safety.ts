import { basename } from "node:path";

/**
 * Return true for dotenv files regardless of their directory. The contents
 * are deliberately never read: these paths may contain credentials.
 */
export function isDotenvPath(path: string): boolean {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Extract ignored dotenv paths from `git ls-files --ignored` output without
 * inspecting file contents. Git emits one path per line for the command used
 * by the worktree safety checks.
 */
export function ignoredDotenvPaths(output: string): string[] {
  return output.split(/\r?\n/).filter(Boolean).filter(isDotenvPath);
}
