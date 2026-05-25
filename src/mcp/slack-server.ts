/**
 * Slack Bot MCP Server (HTTP, shared)
 *
 * Runs as a single HTTP server inside Junior's process. All spawned Claude
 * instances connect to it via the streamable HTTP MCP transport.
 *
 * Messages are sent using the bot token so they come from Junior, not the user.
 * This prevents the event loop that the official Slack plugin causes.
 */

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { readdir, readFile } from "fs/promises";
import { loadAgentDefinition } from "../agents/loader.ts";
import { log } from "../logger.ts";
import { createMemoryStore } from "../memory/factory.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import {
  AGENT_IDENTITIES,
  dispatchableAgentsFor,
  loadOverlayIdentities,
} from "../support/agents.ts";

const MCP_PORT = Number(process.env.MCP_PORT ?? "3456");
const FALLBACK_AGENTS_DIR = ".claude/agents";
const ORG_AGENTS_DIR = "agents-org";
const MEMORY_DB_PATH = process.env.MEMORY_DB_PATH ?? "data/memory.db";

let slack: WebClient;
let sessionStore: SessionStore | undefined;
let worktreeManager: WorktreeManager | undefined;

function registerTools(server: McpServer) {
  server.registerTool(
    "slack_send_message",
    {
      description: "Send a message to a Slack channel or thread as Junior (the bot).",
      inputSchema: {
        text: z.string().describe("Message text (supports Slack mrkdwn formatting)"),
        channel_id: z.string().describe("Channel ID to post in"),
        thread_ts: z.string().optional().describe("Thread timestamp to reply to"),
        reply_broadcast: z.boolean().optional().describe("Also post to the channel (for thread replies)"),
        username: z.string().optional().describe("Optional display name for this bot message"),
        icon_emoji: z.string().optional().describe("Optional emoji icon for this bot message"),
      },
    },
    async ({ text, channel_id, thread_ts, reply_broadcast, username, icon_emoji }) => {
      const identity = {
        ...(username ? { username } : {}),
        ...(icon_emoji ? { icon_emoji } : {}),
      };
      const result = reply_broadcast && thread_ts
        ? await slack.chat.postMessage({ channel: channel_id, text, thread_ts, reply_broadcast: true, ...identity })
        : thread_ts
          ? await slack.chat.postMessage({ channel: channel_id, text, thread_ts, ...identity })
          : await slack.chat.postMessage({ channel: channel_id, text, ...identity });
      return {
        content: [{ type: "text" as const, text: `Message sent (ts: ${result.ts})` }],
      };
    },
  );

  server.registerTool(
    "slack_read_channel",
    {
      description: "Read recent messages from a Slack channel (newest first).",
      inputSchema: {
        channel_id: z.string().describe("Channel ID to read from"),
        limit: z.number().optional().describe("Number of messages (1-100, default 20)"),
        oldest: z.string().optional().describe("Start of time range (unix timestamp)"),
        latest: z.string().optional().describe("End of time range (unix timestamp)"),
      },
    },
    async ({ channel_id, limit, oldest, latest }) => {
      const result = await slack.conversations.history({
        channel: channel_id,
        limit: Math.min(limit ?? 20, 100),
        ...(oldest ? { oldest } : {}),
        ...(latest ? { latest } : {}),
      });

      if (!result.messages?.length) {
        return { content: [{ type: "text" as const, text: "No messages found." }] };
      }

      const lines = result.messages.map((m) => {
        const who = m.bot_id ? `Bot(${m.bot_id})` : `User(${m.user ?? "unknown"})`;
        const txt = (m.text ?? "").slice(0, 500);
        return `[${m.ts}] ${who}: ${txt}`;
      });

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "slack_read_thread",
    {
      description: "Read all replies in a Slack thread.",
      inputSchema: {
        channel_id: z.string().describe("Channel ID"),
        thread_ts: z.string().describe("Parent message timestamp"),
        limit: z.number().optional().describe("Number of replies (1-200, default 100)"),
      },
    },
    async ({ channel_id, thread_ts, limit }) => {
      const result = await slack.conversations.replies({
        channel: channel_id,
        ts: thread_ts,
        limit: Math.min(limit ?? 100, 200),
      });

      if (!result.messages?.length) {
        return { content: [{ type: "text" as const, text: "No messages found." }] };
      }

      const lines = result.messages.map((m) => {
        const who = m.bot_id ? `Bot(${m.bot_id})` : `User(${m.user ?? "unknown"})`;
        const txt = (m.text ?? "").slice(0, 500);
        return `[${m.ts}] ${who}: ${txt}`;
      });

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "slack_search",
    {
      description: "Search for messages across Slack. Supports Slack search syntax (in:#channel, from:@user, before:/after: dates).",
      inputSchema: {
        query: z.string().describe("Search query using Slack search syntax"),
        count: z.number().optional().describe("Number of results (1-20, default 10)"),
        sort: z.enum(["score", "timestamp"]).optional().describe("Sort order (default: score)"),
      },
    },
    async ({ query, count, sort }) => {
      try {
        const result = await slack.search.messages({
          query,
          count: Math.min(count ?? 10, 20),
          sort: sort ?? "score",
        });

        const matches = result.messages?.matches;
        if (!matches?.length) {
          return { content: [{ type: "text" as const, text: "No results found." }] };
        }

        const lines = matches.map((m) => {
          const ch = m.channel;
          const channelName = (ch && typeof ch === "object" && "name" in ch ? String(ch.name) : undefined) ?? "unknown";
          const who = m.user ?? m.username ?? "unknown";
          const txt = (m.text ?? "").slice(0, 300);
          return `#${channelName} | ${who}: ${txt}`;
        });

        return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("missing_scope") || msg.includes("not_allowed")) {
          return { content: [{ type: "text" as const, text: "Error: Bot token lacks search:read scope. Search is unavailable." }] };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "slack_search_users",
    {
      description: "Search for Slack users by name, email, or profile attributes.",
      inputSchema: {
        query: z.string().describe("Search query (name, email, department, etc.)"),
      },
    },
    async ({ query }) => {
      const result = await slack.users.list({ limit: 200 });
      const members = result.members ?? [];

      const q = query.toLowerCase();
      const matches = members.filter((m) => {
        if (m.deleted || m.is_bot) return false;
        const name = (m.real_name ?? "").toLowerCase();
        const display = (m.profile?.display_name ?? "").toLowerCase();
        const email = (m.profile?.email ?? "").toLowerCase();
        const title = (m.profile?.title ?? "").toLowerCase();
        return name.includes(q) || display.includes(q) || email.includes(q) || title.includes(q);
      });

      if (!matches.length) {
        return { content: [{ type: "text" as const, text: "No users found." }] };
      }

      const lines = matches.slice(0, 10).map((m) =>
        `${m.id} | ${m.real_name ?? m.name} | ${m.profile?.email ?? "no email"} | ${m.profile?.title ?? ""}`,
      );

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "slack_upload_file",
    {
      description: "Upload a file to a Slack channel/thread as Junior (the bot).",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file to upload"),
        channel_id: z.string().describe("Channel ID to upload to"),
        thread_ts: z.string().optional().describe("Thread timestamp"),
        comment: z.string().optional().describe("Optional comment to attach"),
      },
    },
    async ({ file_path, channel_id, thread_ts, comment }) => {
      const fileContent = await readFile(file_path);
      const filename = file_path.split("/").pop() ?? "file";

      const uploadUrl = await slack.files.getUploadURLExternal({
        filename,
        length: fileContent.byteLength,
      });

      if (!uploadUrl.upload_url || !uploadUrl.file_id) {
        return { content: [{ type: "text" as const, text: "Error: Failed to get upload URL from Slack" }] };
      }

      await fetch(uploadUrl.upload_url, {
        method: "POST",
        body: fileContent,
      });

      await slack.files.completeUploadExternal({
        files: [{ id: uploadUrl.file_id, title: filename }],
        channel_id,
        ...(thread_ts ? { thread_ts } : {}),
        ...(comment ? { initial_comment: comment } : {}),
      });

      return { content: [{ type: "text" as const, text: `Uploaded ${filename}` }] };
    },
  );

  server.registerTool(
    "register_worktree",
    {
      description:
        "Create a per-thread git worktree for a repo and persist its path in the session. " +
        "Call this on intake for each routed repo after writing state.json. " +
        "Returns the worktree path and branch name.",
      inputSchema: {
        thread_id: z.string().describe("Slack thread timestamp (the session key)"),
        repo: z.string().describe("Repo name as configured in REPOS"),
        branch: z.string().optional().describe("Branch name override. Defaults to slack/<thread_id>"),
      },
    },
    async ({ thread_id, repo: repoName, branch }) => {
      if (!sessionStore) {
        return { content: [{ type: "text" as const, text: "Error: session store not available" }] };
      }
      if (!worktreeManager) {
        return { content: [{ type: "text" as const, text: "Error: worktree manager not available" }] };
      }

      const repoConfig = worktreeManager.getRepo(repoName);
      if (!repoConfig) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: unknown repo "${repoName}". Check REPOS config for valid names.`,
            },
          ],
        };
      }

      let worktreePath: string;
      try {
        // `branch` from the MCP schema is a branch-name override (the new
        // worktree's branch name), NOT a base ref. Pass it as the 4th arg.
        worktreePath = await worktreeManager.createWorktree(
          repoName,
          thread_id,
          undefined,
          branch,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: worktree creation failed — ${msg}` }] };
      }

      // Refetch-then-mutate to avoid clobbering concurrent session writes.
      const session = await sessionStore.get(thread_id);
      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: no session found for thread ${thread_id}. Was it created?`,
            },
          ],
        };
      }
      session.worktreePaths = { ...session.worktreePaths, [repoName]: worktreePath };
      await sessionStore.set(thread_id, session);

      const resolvedBranch = branch ?? worktreeManager.getBranchName(thread_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ path: worktreePath, branch: resolvedBranch }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "agent_search",
    {
      description:
        "Search Junior agent definitions and show whether each agent is currently registered for !<agent> dispatch.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive text to match against agent name, filename, or description"),
        include_public: z.boolean().optional().describe("Include public .claude/agents definitions (default true)"),
        include_private: z.boolean().optional().describe("Include private agents-org definitions (default true)"),
        limit: z.number().optional().describe("Maximum results to return (default 25, max 100)"),
      },
    },
    async ({ query, include_public, include_private, limit }) => {
      const agents = await searchAgentDefinitions({
        query,
        includePublic: include_public ?? true,
        includePrivate: include_private ?? true,
        limit: Math.min(limit ?? 25, 100),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ agents }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "reload_agent_registry",
    {
      description:
        "Reload private overlay agent identities from agents-org so newly added !<agent> workers become dispatchable without restarting Junior.",
      inputSchema: {},
    },
    async () => {
      await loadOverlayIdentities(ORG_AGENTS_DIR);
      const dispatchable = dispatchableAgentsFor("default").sort();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                privateDir: ORG_AGENTS_DIR,
                registeredAgents: Object.keys(AGENT_IDENTITIES).sort(),
                defaultDispatchAllow: dispatchable,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "memory_recall",
    {
      description:
        "Recall sourced associative-memory snippets from Junior's memory database using FTS, tags/entities, and bounded edge traversal.",
      inputSchema: {
        query: z.string().optional().describe("Optional full-text query"),
        tags: z.array(z.string()).optional().describe("Optional normalized or natural tag names"),
        entities: z.array(z.string()).optional().describe("Optional entity names"),
        kinds: z.array(z.enum(["event", "lesson", "summary", "fact", "procedure", "routing_memory"])).optional().describe("Optional memory kinds to include"),
        limit: z.number().optional().describe("Maximum results (default 5)"),
        depth: z.number().optional().describe("Edge traversal depth 0-3 (default 2)"),
        include_inactive: z.boolean().optional().describe("Include archived/inactive memories"),
        include_invalid: z.boolean().optional().describe("Include superseded/stale memories"),
      },
    },
    async ({ query, tags, entities, kinds, limit, depth, include_inactive, include_invalid }) => {
      return withMemoryStore(async (memory) => {
        const results = await memory.recall({
          query,
          tags,
          entities,
          kinds,
          limit,
          depth,
          includeInactive: include_inactive,
          includeInvalid: include_invalid,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }] };
      });
    },
  );

  server.registerTool(
    "memory_consolidate",
    {
      description:
        "Run Junior's deterministic associative-memory consolidation pass: archive cold events, promote repeated routing corrections, and propose draft rules.",
      inputSchema: {
        archive_before_ms: z.number().optional().describe("Archive active low-value events older than this age in ms"),
        low_importance_threshold: z.number().optional().describe("Archive events at or below this importance (default 0.2)"),
        repeated_correction_threshold: z.number().optional().describe("Corrections required for promotion/rule proposal (default 2)"),
      },
    },
    async ({ archive_before_ms, low_importance_threshold, repeated_correction_threshold }) => {
      return withMemoryStore(async (memory) => {
        const result = await memory.consolidate({
          archiveBeforeMs: archive_before_ms,
          lowImportanceThreshold: low_importance_threshold,
          repeatedCorrectionThreshold: repeated_correction_threshold,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      });
    },
  );

  server.registerTool(
    "memory_set_rule_status",
    {
      description:
        "Accept or reject a proposed draft ingestion rule. Accepted rules become active in the live capture path.",
      inputSchema: {
        id: z.string().describe("Rule ID from a consolidation proposal (e.g., rule_tag_foo)"),
        status: z.enum(["accepted", "rejected"]).describe("New status for the rule"),
      },
    },
    async ({ id, status }) => {
      return withMemoryStore(async (memory) => {
        const ok = await memory.setRuleStatus(id, status);
        return { content: [{ type: "text" as const, text: JSON.stringify({ [status]: ok, id }, null, 2) }] };
      });
    },
  );

  server.registerTool(
    "memory_accepted_rules",
    {
      description:
        "List all accepted ingestion rules currently active in the live capture path.",
      inputSchema: {},
    },
    async () => {
      return withMemoryStore(async (memory) => {
        const rules = await memory.getAcceptedRules();
        return { content: [{ type: "text" as const, text: JSON.stringify({ rules }, null, 2) }] };
      });
    },
  );
}

async function withMemoryStore<T>(fn: (memory: ReturnType<typeof createMemoryStore>) => Promise<T>): Promise<T> {
  const memory = createMemoryStore(MEMORY_DB_PATH);
  try {
    return await fn(memory);
  } finally {
    memory.close();
  }
}

interface SearchAgentDefinitionsOptions {
  query?: string;
  includePublic: boolean;
  includePrivate: boolean;
  limit: number;
}

interface AgentSearchResult {
  name: string;
  path: string;
  origin: "private" | "public";
  description: string | null;
  registeredForDispatch: boolean;
  slackIdentity: { username: string; iconEmoji?: string } | null;
}

export async function searchAgentDefinitions(
  options: SearchAgentDefinitionsOptions,
): Promise<AgentSearchResult[]> {
  const dirs: Array<{ path: string; origin: "private" | "public" }> = [];
  if (options.includePrivate) dirs.push({ path: ORG_AGENTS_DIR, origin: "private" });
  if (options.includePublic) dirs.push({ path: FALLBACK_AGENTS_DIR, origin: "public" });

  const query = options.query?.trim().toLowerCase();
  const results: AgentSearchResult[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    const files = await markdownFiles(dir.path);
    for (const file of files) {
      const path = `${dir.path}/${file}`;
      const definition = await loadAgentDefinition(path);
      const name = definition?.name ?? file.replace(/\.md$/, "");
      const description = definition?.description ?? null;
      const haystack = `${name} ${file} ${description ?? ""}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;

      const key = `${dir.origin}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const identity = AGENT_IDENTITIES[name];
      results.push({
        name,
        path,
        origin: dir.origin,
        description,
        registeredForDispatch: Boolean(identity),
        slackIdentity: identity
          ? {
              username: identity.username,
              ...(identity.iconEmoji ? { iconEmoji: identity.iconEmoji } : {}),
            }
          : null,
      });

      if (results.length >= options.limit) return results;
    }
  }

  return results;
}

async function markdownFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Start the shared MCP server. Call once from Junior's main process.
 */
export function startMcpServer(
  botToken: string,
  store?: SessionStore,
  wtManager?: WorktreeManager,
): void {
  slack = new WebClient(botToken);
  sessionStore = store;
  worktreeManager = wtManager;

  const httpServer = createServer(async (req, res) => {
    // Each request gets its own transport (stateless mode).
    // Tools are registered fresh but share the same WebClient.
    const mcpServer = new McpServer({ name: "slack-bot", version: "0.1.0" });
    registerTools(mcpServer);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  httpServer.listen(MCP_PORT, () => {
    log.info("mcp", `Slack bot MCP server listening on port ${MCP_PORT}`);
  });
}
