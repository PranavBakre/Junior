import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectJavaScriptPackageManager } from "./package-manager.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "junior-package-manager-"));
  roots.push(root);
  return root;
}

describe("detectJavaScriptPackageManager", () => {
  it("prefers the packageManager field over lockfiles", async () => {
    const root = await workspace();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.0.0" }),
    );
    await writeFile(join(root, "package-lock.json"), "{}");

    expect(await detectJavaScriptPackageManager(root)).toBe("pnpm");
  });

  it.each([
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
  ] as const)("detects %s", async (filename, expected) => {
    const root = await workspace();
    await writeFile(join(root, filename), "");

    expect(await detectJavaScriptPackageManager(root)).toBe(expected);
  });

  it("fails closed for conflicting lockfile families", async () => {
    const root = await workspace();
    await writeFile(join(root, "bun.lock"), "");
    await writeFile(join(root, "package-lock.json"), "{}");

    expect(await detectJavaScriptPackageManager(root)).toBeNull();
  });

  it("does not reinterpret an explicitly unsupported manager", async () => {
    const root = await workspace();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.0.0" }),
    );
    await writeFile(join(root, "package-lock.json"), "{}");

    expect(await detectJavaScriptPackageManager(root)).toBeNull();
  });

  it("fails closed when repository metadata declares no manager", async () => {
    expect(await detectJavaScriptPackageManager(await workspace())).toBeNull();
  });
});
