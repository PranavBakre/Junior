import type { RepoConfig } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";
import { loadAgentDefinition } from "./loader.ts";
import type { AgentDefinition } from "./loader.ts";

export class AgentRouter {
  private repos: RepoConfig[];
  private fallbackAgentsDir: string;

  constructor(repos: RepoConfig[], fallbackAgentsDir: string) {
    this.repos = repos;
    this.fallbackAgentsDir = fallbackAgentsDir;
  }

  async resolveAgent(
    session: ThreadSession,
  ): Promise<AgentDefinition | null> {
    if (!session.agentType) return null;

    // Try target repo first
    if (session.targetRepo) {
      const repo = this.repos.find((r) => r.name === session.targetRepo);
      if (repo) {
        const repoPath = `${repo.path}/.claude/agents/${session.agentType}.md`;
        const definition = await loadAgentDefinition(repoPath);
        if (definition) return definition;
      }
    }

    // Fallback
    const fallbackPath = `${this.fallbackAgentsDir}/${session.agentType}.md`;
    return loadAgentDefinition(fallbackPath);
  }

  async composeSystemPrompt(
    session: ThreadSession,
  ): Promise<string | null> {
    const definition = await this.resolveAgent(session);
    if (!definition) return null;

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

    // Load common preamble from fallback
    const fallbackCommonDir = `${this.fallbackAgentsDir}/common`;
    const fallbackFiles = await readMarkdownFiles(fallbackCommonDir);
    preambleParts.push(...fallbackFiles);

    const commonPreamble = preambleParts.join("\n\n");

    if (commonPreamble) {
      return commonPreamble + "\n\n" + definition.prompt;
    }

    return definition.prompt;
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
