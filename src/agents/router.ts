import type { RepoConfig } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";
import { loadAgentDefinition } from "./loader.ts";
import type { AgentDefinition } from "./loader.ts";

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
 *   - selected files from target repo common, if present
 *   - otherwise selected files from fallback common
 *   - then matching org overlay common files add additively
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
    const agentName = agentNameForSession(session);
    if (!agentName) return null;

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
    const definition = await this.resolveAgent(session);
    const commonProfile = definition?.common ?? ["core"];

    const preambleParts: string[] = [];

    // Load selected common preamble from target repo.
    if (session.targetRepo) {
      const repo = this.repos.find((r) => r.name === session.targetRepo);
      if (repo) {
        const repoCommonDir = `${repo.path}/.claude/agents/common`;
        const repoFiles = await readSelectedMarkdownFiles(repoCommonDir, commonProfile);
        preambleParts.push(...repoFiles);
      }
    }

    // Load selected common preamble from fallback only if target repo didn't
    // have any selected files. This preserves the old target-or-fallback
    // common-root behavior while avoiding a glob-all common prompt.
    if (preambleParts.length === 0) {
      const fallbackCommonDir = `${this.fallbackAgentsDir}/common`;
      const fallbackFiles = await readSelectedMarkdownFiles(fallbackCommonDir, commonProfile);
      preambleParts.push(...fallbackFiles);
    }

    // Append matching org overlay common files additively. Unlike the previous
    // implementation, this uses the same common profile instead of appending
    // every org common file to every agent.
    if (this.orgAgentsDir) {
      const orgCommonDir = `${this.orgAgentsDir}/common`;
      const orgFiles = await readSelectedMarkdownFiles(orgCommonDir, commonProfile);
      preambleParts.push(...orgFiles);
    }

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

async function readSelectedMarkdownFiles(
  dirPath: string,
  names: string[],
): Promise<string[]> {
  const results: string[] = [];
  const seen = new Set<string>();

  try {
    for (const name of names) {
      const stem = name.replace(/\.md$/, "");
      if (!stem || seen.has(stem)) continue;
      seen.add(stem);
      const file = Bun.file(`${dirPath}/${stem}.md`);
      const exists = await file.exists();
      if (exists) {
        const content = await file.text();
        results.push(content.trim());
      }
    }
  } catch {
    // Directory doesn't exist or not readable — return empty
  }

  return results;
}
