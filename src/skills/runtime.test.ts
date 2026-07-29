import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { listTrustedSkills, resolveTrustedSkill } from "./registry.ts";
import { prepareSkillRuntime, skillInvocationPrompt } from "./runtime.ts";

describe("trusted skill runtime", () => {
  it("resolves canonical SKILL.md packages without loading bodies into prompts", () => {
    const skill = resolveTrustedSkill("sentry-fetch");
    expect(skill).not.toBeNull();
    expect(skill?.execution).toBe("stateless");
    expect(skill?.capabilities).toEqual(["pipeline-artifact-write"]);
    expect(readFileSync(skill!.path, "utf8")).toContain("pipeline_report_outcome");

    const prompt = skillInvocationPrompt("opencode", skill!, "inspect the last hour");
    expect(prompt).toContain('Load the "sentry-fetch" skill');
    expect(prompt).not.toContain("# Sentry evidence");
  });

  it("publishes only the selected skill in Claude and OpenCode discovery views", () => {
    const skill = resolveTrustedSkill("vercel-status")!;
    const runtime = prepareSkillRuntime(skill);
    const canonicalDir = dirname(skill.path);
    const claudeSkill = resolve(
      runtime.claudeAddDir,
      ".claude/skills/vercel-status",
    );
    const openCodeSkill = resolve(
      runtime.openCodeConfigDir,
      "skills/vercel-status",
    );

    expect(existsSync(claudeSkill)).toBe(true);
    expect(existsSync(openCodeSkill)).toBe(true);
    expect(realpathSync(claudeSkill)).toBe(canonicalDir);
    expect(realpathSync(openCodeSkill)).toBe(canonicalDir);
    expect(existsSync(resolve(runtime.claudeAddDir, ".claude/skills/sentry-fetch")))
      .toBe(false);
  });

  it("lists unique provider-neutral names", () => {
    expect(listTrustedSkills().map((skill) => skill.name)).toEqual([
      "nr-research",
      "sentry-fetch",
      "vercel-status",
    ]);
  });
});
