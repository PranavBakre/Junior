import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type JavaScriptPackageManager = "npm" | "pnpm" | "bun";

const LOCKFILE_FAMILIES: ReadonlyArray<{
  manager: JavaScriptPackageManager;
  files: readonly string[];
}> = [
  { manager: "pnpm", files: ["pnpm-lock.yaml", "pnpm-workspace.yaml"] },
  { manager: "bun", files: ["bun.lock", "bun.lockb"] },
  { manager: "npm", files: ["package-lock.json", "npm-shrinkwrap.json"] },
];

/**
 * Discover the JavaScript package manager declared by a worktree. Prefer the
 * standard package.json `packageManager` field; otherwise accept exactly one
 * lockfile family. Conflicting or absent metadata fails closed.
 */
export async function detectJavaScriptPackageManager(
  worktreePath: string,
): Promise<JavaScriptPackageManager | null> {
  const declared = await packageManagerFromPackageJson(worktreePath);
  if (declared !== undefined) return declared;

  let entries: Set<string>;
  try {
    entries = new Set(await readdir(worktreePath));
  } catch {
    return null;
  }
  const detected = LOCKFILE_FAMILIES.filter((family) =>
    family.files.some((filename) => entries.has(filename)),
  ).map((family) => family.manager);
  return detected.length === 1 ? detected[0]! : null;
}

async function packageManagerFromPackageJson(
  worktreePath: string,
): Promise<JavaScriptPackageManager | null | undefined> {
  try {
    const raw = await readFile(join(worktreePath, "package.json"), "utf8");
    const value = (JSON.parse(raw) as { packageManager?: unknown }).packageManager;
    if (typeof value !== "string") return undefined;
    const name = value.trim().split("@")[0];
    return name === "npm" || name === "pnpm" || name === "bun" ? name : null;
  } catch {
    return undefined;
  }
}
