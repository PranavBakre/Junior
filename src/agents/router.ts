import type { RepoConfig } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";
import { loadAgentDefinition } from "./loader.ts";
import type { AgentDefinition } from "./loader.ts";

/**
 * Session agent names that resolve to another agent's definition file. `lead`
 * and `thinker` retired as standalone agents in the 3-way orchestrator merge:
 * both now use `default.md`. `lead` survives only as a support-channel session
 * marker (prod CHANNEL_DEFAULTS) — the alias keeps that marker working without
 * a config migration, and composeSystemPrompt layers the bug-pipeline preamble
 * on top for those sessions.
 */
const AGENT_DEFINITION_ALIASES: Record<string, string> = {
  lead: "default",
  thinker: "default",
};

function resolveDefinitionName(rawName: string): string {
  return AGENT_DEFINITION_ALIASES[rawName] ?? rawName;
}

/**
 * Resolves agent definitions and composes the system prompt.
 *
 * Search order for an agent .md file (first match wins):
 *   1. target repo's .claude/agents/<name>.md (if session has a targetRepo)
 *   2. org overlay dir (private submodule mount, if configured)
 *   3. fallback dir (junior's public .claude/agents)
 *
 * Common preamble files are selected by each agent's `common:` profile and
 * load in declared order:
 *   - selected files from target repo common, falling back per file to public
 *   - then matching org overlay common files append additively
 */
export class AgentRouter {
  private repos: RepoConfig[];
  private fallbackAgentsDir: string;
  private orgAgentsDir: string | null;

  constructor(
    repos: RepoConfig[],
    fallbackAgentsDir: string,
    orgAgentsDir?: string | null,
  ) {
    this.repos = repos;
    this.fallbackAgentsDir = fallbackAgentsDir;
    this.orgAgentsDir = orgAgentsDir ?? null;
  }

  async resolveAgent(
    session: ThreadSession,
  ): Promise<AgentDefinition | null> {
    const rawName = agentNameForSession(session);
    if (!rawName) return null;
    const agentName = resolveDefinitionName(rawName);

    const candidates: string[] = [];

    if (session.targetRepo) {
      const repo = this.repos.find((r) => r.name === session.targetRepo);
      if (repo) {
        candidates.push(`${repo.path}/.claude/agents/${agentName}.md`);
      }
    }
    if (this.orgAgentsDir) {
      candidates.push(`${this.orgAgentsDir}/${agentName}.md`);
    }
    candidates.push(`${this.fallbackAgentsDir}/${agentName}.md`);

    for (const path of candidates) {
      const definition = await loadAgentDefinition(path);
      if (definition) return definition;
    }
    return null;
  }

  async composeSystemPrompt(
    session: ThreadSession,
  ): Promise<string | null> {
    const rawName = agentNameForSession(session);
    const definition = await this.resolveAgent(session);
    const commonProfile = [...(definition?.common ?? ["core"])];

    // Support-channel sessions (marker "lead", plus resumed pre-merge "thinker"
    // sessions) run the bug pipeline. Append the pipeline preambles AFTER the
    // agent's declared profile so they participate like any other common name:
    // readProfileMarkdownFiles resolves them through the target-repo → public
    // tiers, and the org overlay tier can supplement or override them by the
    // same additive mechanics. merge-workflow and runtime-environment ride along
    // because the pipeline's merge step and dev-server/bug-folder contracts live
    // there — the lean default profile deliberately omits them for casual
    // threads. Casual "default" sessions get none of this.
    if (rawName === "lead" || rawName === "thinker") {
      for (const name of ["merge-workflow", "runtime-environment", "bug-pipeline"]) {
        if (!commonProfile.includes(name)) commonProfile.push(name);
      }
    }

    const preambleParts: string[] = [];
    const loadedCommonStems = new Set<string>();
    let targetCommonDir: string | null = null;

    if (session.targetRepo) {
      const repo = this.repos.find((r) => r.name === session.targetRepo);
      if (repo) {
        targetCommonDir = `${repo.path}/.claude/agents/common`;
      }
    }

    const baseFiles = await readProfileMarkdownFiles({
      names: commonProfile,
      primaryDir: targetCommonDir,
      fallbackDir: `${this.fallbackAgentsDir}/common`,
    });
    preambleParts.push(...baseFiles.contents);
    addLoadedStems(loadedCommonStems, baseFiles.foundStems);

    // Append matching org overlay common files additively. Unlike the previous
    // implementation, this uses the same common profile instead of appending
    // every org common file to every agent.
    if (this.orgAgentsDir) {
      const orgCommonDir = `${this.orgAgentsDir}/common`;
      const orgFiles = await readProfileMarkdownFiles({
        names: commonProfile,
        primaryDir: orgCommonDir,
        fallbackDir: null,
      });
      preambleParts.push(...orgFiles.contents);
      addLoadedStems(loadedCommonStems, orgFiles.foundStems);
    }

    warnAboutMissingCommonFiles(commonProfile, loadedCommonStems);

    const commonPreamble = preambleParts.join("\n\n");

    if (commonPreamble && definition) {
      return commonPreamble + "\n\n" + definition.prompt;
    }
    if (commonPreamble) return commonPreamble;
    if (definition) return definition.prompt;
    return null;
  }
}

function agentNameForSession(session: ThreadSession): string | null {
  if (session.agentType) return session.agentType;
  if (session.activeAgentName === "default") return "default";
  return null;
}

interface ReadProfileMarkdownFilesOptions {
  names: string[];
  primaryDir: string | null;
  fallbackDir: string | null;
}

interface ReadProfileMarkdownFilesResult {
  contents: string[];
  foundStems: Set<string>;
}

async function readProfileMarkdownFiles(
  options: ReadProfileMarkdownFilesOptions,
): Promise<ReadProfileMarkdownFilesResult> {
  const contents: string[] = [];
  const foundStems = new Set<string>();
  const seen = new Set<string>();

  for (const name of options.names) {
    const stem = normalizeCommonStem(name);
    if (!stem || seen.has(stem)) continue;
    seen.add(stem);

    const searchDirs = [options.primaryDir, options.fallbackDir].filter(
      (dir): dir is string => Boolean(dir),
    );
    const content = await readFirstExistingMarkdownFile(searchDirs, stem);
    if (content !== null) {
      contents.push(content);
      foundStems.add(stem);
    }
  }

  return { contents, foundStems };
}

async function readFirstExistingMarkdownFile(
  dirPaths: string[],
  stem: string,
): Promise<string | null> {
  for (const dirPath of dirPaths) {
    const content = await readMarkdownFileIfExists(`${dirPath}/${stem}.md`);
    if (content !== null) return content;
  }
  return null;
}

async function readMarkdownFileIfExists(filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return null;
    return (await file.text()).trim();
  } catch {
    console.warn(`[agents] failed to read common file: ${filePath}`);
    return null;
  }
}

function normalizeCommonStem(name: string): string {
  return name.trim().replace(/\.md$/, "");
}

function addLoadedStems(target: Set<string>, source: Set<string>): void {
  for (const stem of source) target.add(stem);
}

function warnAboutMissingCommonFiles(
  names: string[],
  loadedStems: Set<string>,
): void {
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const stem = normalizeCommonStem(name);
    if (!stem || seen.has(stem)) continue;
    seen.add(stem);
    if (!loadedStems.has(stem)) missing.push(`${stem}.md`);
  }

  if (missing.length > 0) {
    console.warn(
      `[agents] common profile requested missing file(s): ${missing.join(", ")}`,
    );
  }

  if (loadedStems.size === 0 && names.length > 0) {
    console.warn(`[agents] no common files loaded for profile: ${names.join(",")}`);
  }
}
