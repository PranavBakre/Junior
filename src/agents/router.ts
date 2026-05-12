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
 * Common preamble files load in this order:
 *   - target repo's .claude/agents/common/*.md (if any), OR fallback common/*.md
 *   - then org overlay common/*.md is appended additively (so org-wide
 *     invariants like the merge-workflow rules reach every agent regardless
 *     of which repo the public common came from)
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
    if (!session.agentType) return null;

    const candidates: string[] = [];

    if (session.targetRepo) {
      const repo = this.repos.find((r) => r.name === session.targetRepo);
      if (repo) {
        candidates.push(`${repo.path}/.claude/agents/${session.agentType}.md`);
      }
    }
    if (this.orgAgentsDir) {
      candidates.push(`${this.orgAgentsDir}/${session.agentType}.md`);
    }
    candidates.push(`${this.fallbackAgentsDir}/${session.agentType}.md`);

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

    const preambleParts: string[] = [];

    // Load common preamble from target repo
    if (session.targetRepo) {
      const repo = this.repos.find((r) => r.name === session.targetRepo);
      if (repo) {
        const repoCommonDir = `${repo.path}/.claude/agents/common`;
        const repoFiles = await readMarkdownFiles(repoCommonDir);
        preambleParts.push(...repoFiles);
      }
    }

    // Load common preamble from fallback only if target repo didn't have any
    if (preambleParts.length === 0) {
      const fallbackCommonDir = `${this.fallbackAgentsDir}/common`;
      const fallbackFiles = await readMarkdownFiles(fallbackCommonDir);
      preambleParts.push(...fallbackFiles);
    }

    // Always append org overlay common files (additive). This keeps org-wide
    // invariants — credentials, merge protocol, infra paths — visible to every
    // agent regardless of which repo's public common loaded above.
    if (this.orgAgentsDir) {
      const orgCommonDir = `${this.orgAgentsDir}/common`;
      const orgFiles = await readMarkdownFiles(orgCommonDir);
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

async function readMarkdownFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  try {
    const glob = new Bun.Glob("*.md");
    const entries: string[] = [];

    for await (const entry of glob.scan({ cwd: dirPath })) {
      entries.push(entry);
    }

    entries.sort();

    for (const entry of entries) {
      const file = Bun.file(`${dirPath}/${entry}`);
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
