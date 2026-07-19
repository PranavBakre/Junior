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
import { createProfileStore } from "../memory/profiles/index.ts";
import type { ProfileStore, Profile } from "../memory/profiles/index.ts";
import {
  createSlackPeopleResolver,
  runConsolidationSweep,
} from "../memory/consolidation/index.ts";
import { createRunnerInvoke } from "../memory/consolidation/runner.ts";
import type { MemoryStore } from "../memory/store.ts";
import type {
  ClaimKind,
  ClaimRecallFilters,
  ClaimRecallResult,
} from "../memory/types.ts";
import type { EmbeddingProvider } from "../memory/embedding/types.ts";
// `import type` keeps the heavy harrier/transformers graph (pulled in by the
// embedding factory's local provider) out of the module graph; the factory is
// dynamically imported only when a real provider is first constructed.
import type { EmbeddingProviderKind } from "../memory/embedding/factory.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { SessionManager } from "../session/manager.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import {
  AGENT_IDENTITIES,
  dispatchableAgentsFor,
  isPersistentAgent,
  loadOverlayIdentities,
} from "../support/agents.ts";
import { parsePureAgentDirectiveResponse } from "../support/directives.ts";
import { parseSlackMcpRunContext, type SlackMcpRunContext } from "./context.ts";
import { registerWhatsAppTools } from "./whatsapp-tools.ts";
import { handleMongoMcpRequest } from "./mongodb-proxy.ts";
import { registerPendingApproval } from "./approval.ts";
import { prepareSlackResponseWithActions, type SlackActionButtonSpec } from "../slack/formatting.ts";
import { buildActionBlocks, splitActionMessageText } from "../slack/responder.ts";
import type { SlackActionStore } from "../slack/action-store.ts";
import { disableAgentActionMessages } from "../slack/action-buttons.ts";

const MCP_PORT = Number(process.env.MCP_PORT ?? "3456");
const FALLBACK_AGENTS_DIR = ".claude/agents";
const ORG_AGENTS_DIR = "agents-org";
const MEMORY_DB_PATH = process.env.MEMORY_DB_PATH ?? "data/memory.db";
const MEMORY_EMBED_PROVIDER = parseEmbedProviderKind(process.env.MEMORY_EMBED_PROVIDER);

let slack: WebClient;

// Lazily-constructed singletons for the v3 memory read/write path. The local
// embedding provider lazy-loads a ~500MB ONNX model on its first embed (~20s),
// so it must NEVER be built at server startup — only on the first memory_recall
// / memory_add call. The factory is dynamically imported for the same reason
// (its static graph pulls @huggingface/transformers). One instance is shared
// across every tool call so the model loads at most once per process.
let embeddingProvider: EmbeddingProvider | undefined;
let profileStoreSingleton: ProfileStore | undefined;

async function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (!embeddingProvider) {
    const { createEmbeddingProvider } = await import("../memory/embedding/factory.ts");
    embeddingProvider = createEmbeddingProvider(MEMORY_EMBED_PROVIDER);
  }
  return embeddingProvider;
}

function getProfileStore(): ProfileStore {
  if (!profileStoreSingleton) profileStoreSingleton = createProfileStore();
  return profileStoreSingleton;
}

function parseEmbedProviderKind(value: string | undefined): EmbeddingProviderKind {
  const v = (value ?? "local").trim();
  if (v === "local" || v === "hashing") return v;
  throw new Error(
    `Invalid MEMORY_EMBED_PROVIDER: ${value} (expected local|hashing)`,
  );
}
let sessionStore: SessionStore | undefined;
let worktreeManager: WorktreeManager | undefined;
let sessionManager: SessionManager | undefined;
let slackActionStore: SlackActionStore | undefined;

function registerTools(server: McpServer, runContext: SlackMcpRunContext | null = null) {
  registerWhatsAppTools(server, {
    runContext,
    // Deny-by-default until the SessionManager is wired in: without it the
    // admin roster can't be consulted, and the archive is personal data.
    isAdmin: (userId) => sessionManager?.isAdmin(userId) ?? Promise.resolve(false),
  });
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
        icon_url: z.string().optional().describe("Optional image URL icon for this bot message"),
        image_url: z.string().optional().describe("Alias for icon_url"),
      },
    },
    async ({ text, channel_id, thread_ts, reply_broadcast, username, icon_emoji, icon_url, image_url }) => {
      const internalDispatch = await dispatchAgentDirectivesFromSlackPost({
        text,
        channelId: channel_id,
        threadTs: thread_ts,
        runContext,
      });
      if (internalDispatch) {
        return {
          content: [{ type: "text" as const, text: internalDispatch }],
        };
      }

      const prepared = prepareSlackResponseWithActions(text);
      if (prepared === null) {
        return {
          content: [{ type: "text" as const, text: "Message suppressed" }],
        };
      }

      const resolvedIconUrl = icon_url ?? image_url;
      const identity = {
        ...(username ? { username } : {}),
        ...(icon_emoji ? { icon_emoji } : {}),
        ...(resolvedIconUrl && !icon_emoji ? { icon_url: resolvedIconUrl } : {}),
      };
      const sourceAgent = runContext?.agent ?? "mcp";
      if (slackActionStore && thread_ts && prepared.actions.length > 0) {
        await disableAgentActionMessages(
          slackActionStore,
          slack,
          thread_ts,
          sourceAgent,
        );
      }
      const buttonTokens = slackActionStore
        ? prepared.actions.map((action) => ({
            action,
            token: crypto.randomUUID(),
          }))
        : [];
      const chunks = buttonTokens.length > 0
        ? splitActionMessageText(prepared.text)
        : [prepared.text];
      const blocks = buttonTokens.length > 0
        ? buildActionBlocks(
            chunks[0] ?? prepared.text,
            buttonTokens.map(({ action, token }) => ({
              token,
              label: action.label,
              style: action.style,
            })),
          )
        : undefined;
      let firstResult: Awaited<ReturnType<typeof slack.chat.postMessage>> | null = null;
      let firstText = chunks[0] ?? prepared.text;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const chunkBlocks = i === 0 ? blocks : undefined;
        const message = reply_broadcast && thread_ts
          ? { channel: channel_id, text: chunk, thread_ts, reply_broadcast: true, ...(chunkBlocks ? { blocks: chunkBlocks } : {}), ...identity }
          : thread_ts
            ? { channel: channel_id, text: chunk, thread_ts, ...(chunkBlocks ? { blocks: chunkBlocks } : {}), ...identity }
            : { channel: channel_id, text: chunk, ...(chunkBlocks ? { blocks: chunkBlocks } : {}), ...identity };
        const result = await slack.chat.postMessage(message as Parameters<typeof slack.chat.postMessage>[0]);
        if (!firstResult) {
          firstResult = result;
          firstText = chunk;
        }
      }
      if (slackActionStore && firstResult?.ts && buttonTokens.length > 0) {
        await slackActionStore.createMany(
          buttonTokens.map(({ action, token }) => ({
            token,
            channelId: channel_id,
            threadTs: thread_ts ?? firstResult.ts!,
            messageTs: firstResult.ts!,
            messageText: firstText,
            action,
            sourceAgent,
          })),
        );
      }
      return {
        content: [{ type: "text" as const, text: `Message sent (ts: ${firstResult?.ts})` }],
      };
    },
  );

  server.registerTool(
    "request_permission",
    {
      description:
        "Ask a human in the Slack thread to approve or deny a pending tool call, and BLOCK until they respond. " +
        "Wired to Claude's --permission-prompt-tool: Claude passes the pending tool's name and input; " +
        "this posts Allow/Deny buttons and returns the human's decision.",
      // Claude's permission-prompt-tool passes the pending tool name plus its
      // input. Accept a permissive shape (loosest pattern in this codebase,
      // matching the mongodb proxy) so we never reject Claude's payload.
      inputSchema: z.object({ tool_name: z.string() }).passthrough(),
    },
    async (args) => {
      const toolName = typeof args.tool_name === "string" ? args.tool_name : "(unknown tool)";
      // The original tool input Claude wants approved. Claude may send it under
      // `input` or `tool_input`; fall back to the remaining args.
      const { tool_name: _toolName, input, tool_input, ...rest } = args as Record<string, unknown>;
      const toolInput = input ?? tool_input ?? (Object.keys(rest).length > 0 ? rest : undefined);

      if (!runContext || !slackActionStore) {
        // Fail closed: without a thread to ask or a store to persist the
        // buttons, we cannot get a human decision. Deny.
        return permissionResult("deny", undefined, "Denied: Slack approval context unavailable.");
      }

      const channelId = runContext.channel;
      const threadTs = runContext.threadId;
      const approvalToken = crypto.randomUUID();

      const inputPreview = renderPermissionInput(toolInput);
      const text =
        `:lock: *Permission requested* by \`${runContext.agent}\`\n\`${toolName}\`` +
        (inputPreview ? `\n${inputPreview}` : "");

      const buttons: Array<{ action: SlackActionButtonSpec; token: string }> = [
        {
          action: {
            id: "permission-allow",
            label: "Allow",
            style: "primary",
            type: "request_permission",
            approvalToken,
            decision: "allow",
          },
          token: crypto.randomUUID(),
        },
        {
          action: {
            id: "permission-deny",
            label: "Deny",
            style: "danger",
            type: "request_permission",
            approvalToken,
            decision: "deny",
          },
          token: crypto.randomUUID(),
        },
      ];

      const blocks = buildActionBlocks(
        text,
        buttons.map(({ action, token }) => ({
          token,
          label: action.label,
          style: action.style,
        })),
      );

      const posted = await slack.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
        blocks,
      } as Parameters<typeof slack.chat.postMessage>[0]);

      if (!posted.ts) {
        return permissionResult("deny", toolInput, "Denied: failed to post approval prompt to Slack.");
      }

      await slackActionStore.createMany(
        buttons.map(({ action, token }) => ({
          token,
          channelId,
          threadTs,
          messageTs: posted.ts!,
          messageText: text,
          action,
          sourceAgent: runContext.agent,
        })),
      );

      const decision = await registerPendingApproval(approvalToken);
      return decision === "allow"
        ? permissionResult("allow", toolInput)
        : permissionResult("deny", toolInput, "Denied by human in Slack");
    },
  );

  server.registerTool(
    "slack_send_dm",
    {
      description: "Send a direct message to a Slack user ID as Junior (the bot). Opens the DM channel first.",
      inputSchema: {
        user_id: z.string().describe("Slack user ID to DM, e.g. U03PNSJ33S5"),
        text: z.string().describe("Message text (supports Slack mrkdwn formatting)"),
        username: z.string().optional().describe("Optional display name for this bot message"),
        icon_emoji: z.string().optional().describe("Optional emoji icon for this bot message"),
        icon_url: z.string().optional().describe("Optional image URL icon for this bot message"),
        image_url: z.string().optional().describe("Alias for icon_url"),
      },
    },
    async ({ user_id, text, username, icon_emoji, icon_url, image_url }) => {
      try {
        const result = await sendSlackDirectMessage(slack, {
          userId: user_id,
          text,
          username,
          iconEmoji: icon_emoji,
          imageUrl: icon_url ?? image_url,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `DM sent (channel: ${result.channelId}, ts: ${result.ts})`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("missing_scope") || msg.includes("not_allowed")) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Bot token lacks permission to open or post DMs. Required Slack scopes include im:write and chat:write.",
              },
            ],
          };
        }
        throw err;
      }
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
    "agent_dispatch",
    {
      description:
        "Internally dispatch a prompt to a registered Junior persistent agent in a Slack thread without posting a Slack !<agent> directive.",
      inputSchema: {
        agent_name: z.string().describe("Target persistent agent name, e.g. review, reproducer"),
        prompt: z.string().describe("Prompt to send to the agent"),
        channel_id: z.string().describe("Slack channel ID for the thread context"),
        thread_ts: z.string().describe("Slack thread timestamp / session key"),
        user_id: z.string().optional().describe("User id to record on the synthetic internal event (default: mcp-internal)"),
        trigger_ts: z.string().optional().describe("Slack message timestamp that caused the dispatch. Defaults to thread_ts."),
      },
    },
    async ({ agent_name, prompt, channel_id, thread_ts, user_id, trigger_ts }) => {
      if (!sessionManager) {
        return { content: [{ type: "text" as const, text: "Error: session manager not available" }] };
      }
      const targetAgent = agent_name.trim();
      if (!isPersistentAgent(targetAgent)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: unknown agent "${targetAgent}". Use agent_search to find registered agents.`,
            },
          ],
        };
      }

      if (!runContext) {
        return { content: [{ type: "text" as const, text: "Error: MCP run context missing; cannot authenticate caller" }] };
      }
      if (runContext.threadId !== thread_ts || runContext.channel !== channel_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: dispatch target does not match authenticated MCP run context",
            },
          ],
        };
      }

      const caller = runContext.agent;
      const allowed = dispatchableAgentsFor(caller);
      if (!allowed.includes(targetAgent)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${caller} is not allowed to dispatch ${targetAgent}. Allowed: ${allowed.join(", ") || "(none)"}.`,
            },
          ],
        };
      }

      const now = Date.now();
      await sessionManager.handleAgentMessage(
        {
          threadId: thread_ts,
          channel: channel_id,
          user: user_id ?? "mcp-internal",
          text: prompt,
          ts: trigger_ts ?? thread_ts,
          command: null,
          isSelfBot: true,
          botUsername: AGENT_IDENTITIES[caller]?.username,
          dedupeKey: `${thread_ts}:mcp:${targetAgent}:${now}`,
        },
        targetAgent,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, agent: targetAgent, thread: thread_ts }),
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
        "Recall Junior's v3 memory over two channels and merge them. (1) KEYED profiles: " +
        "when you pass `entity_refs` (the people/repos in front of you, e.g. 'pranav:person', " +
        "'gx-backend:repo'), their markdown profiles are fetched VERBATIM by key — no embedding, " +
        "no ranking — and are Junior-internal context (never surface a profile verbatim in a thread). " +
        "(2) SEMANTIC claims: `query` is embedded locally and matched against the atomic " +
        "lesson/fact/situation-claim store by cosine (filtered by `repo`/`kinds`). " +
        "Returns the keyed profiles plus the top-k claims (text, score, repo, tags).",
      inputSchema: {
        query: z.string().describe("Natural-language query, embedded for semantic claim retrieval"),
        repo: z.string().optional().describe("Scope claims to a repo (e.g. 'gx-backend')"),
        kinds: z
          .array(z.enum(["lesson", "fact", "situation-claim"]))
          .optional()
          .describe("Restrict claims to these kinds (default: all)"),
        entity_refs: z
          .array(z.string())
          .optional()
          .describe(
            "Keyed profile lookups, each shaped '<slug>:<kind>' (e.g. 'pranav:person', 'gx-backend:repo'). Fetched verbatim by key, not embedded.",
          ),
        limit: z.number().optional().describe("Max semantic claims to return (default 5, max 50)"),
      },
    },
    async ({ query, repo, kinds, entity_refs, limit }) => {
      return withMemoryStore(async (memory) => {
        const result = await recallMemory(
          { query, repo, kinds, entityRefs: entity_refs, limit },
          { store: memory, provider: await getEmbeddingProvider(), profileStore: getProfileStore() },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      });
    },
  );

  server.registerTool(
    "memory_add",
    {
      description:
        "Add a single atomic claim to Junior's v3 semantic memory and embed it in one step. " +
        "The text is embedded locally (document mode) and stored as a lesson/fact/situation-claim row " +
        "with its embedding co-located, so it is immediately retrievable by `memory_recall`. Write ONE " +
        "atomic claim per call (the unit of semantic recall), not a paragraph. Returns the stored claim id.",
      inputSchema: {
        text: z.string().describe("One atomic claim — the authoritative text that gets embedded"),
        kind: z
          .enum(["lesson", "fact", "situation-claim"])
          .optional()
          .describe("Claim kind (default 'lesson')"),
        repo: z.string().optional().describe("Associate the claim with a repo (filter column)"),
        tags: z.array(z.string()).optional().describe("Optional filter tags"),
      },
    },
    async ({ text, kind, repo, tags }) => {
      return withMemoryStore(async (memory) => {
        const result = await addMemory(
          { text, kind, repo, tags },
          { store: memory, provider: await getEmbeddingProvider(), profileStore: getProfileStore() },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      });
    },
  );

  server.registerTool(
    "memory_consolidate",
    {
      description:
        "Run Junior's v3 memory consolidation: read the unconsolidated source records " +
        "(kind-filtered to the high-value set, then bin-packed by size into batched runner " +
        "calls that club several threads together), ask the runner LLM for derivations, and " +
        "persist episodes, profiles, and claims through the v3 gates. " +
        "Processed records are stamped consolidated so they are derived from exactly once. " +
        "Takes no inputs — it drains all pending source records.",
      inputSchema: {},
    },
    async () => {
      return withMemoryStore(async (memory) => {
        const reports = await runConsolidationSweep({
          store: memory,
          profileStore: getProfileStore(),
          embedder: await getEmbeddingProvider(),
          invoke: createRunnerInvoke({}),
          resolvePeople: createSlackPeopleResolver(slack),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ reports }, null, 2) }] };
      });
    },
  );

}

/**
 * Build the MCP tool result Claude's `--permission-prompt-tool` contract
 * expects: a single text content block whose text is a JSON-stringified
 * `{ behavior, updatedInput }` (allow) or `{ behavior, message }` (deny).
 *
 * On allow we echo the original tool input as `updatedInput` (the documented
 * safe form — Claude requires the updated input it should run with).
 */
function permissionResult(
  behavior: "allow" | "deny",
  input: unknown,
  message?: string,
): { content: Array<{ type: "text"; text: string }> } {
  const payload =
    behavior === "allow"
      ? { behavior, updatedInput: (input ?? {}) as Record<string, unknown> }
      : { behavior, message: message ?? "Denied by human in Slack" };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Compact, Slack-safe rendering of the pending tool's input for the prompt. */
function renderPermissionInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  let serialized: string;
  try {
    serialized = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    serialized = String(input);
  }
  if (!serialized.trim()) return "";
  const MAX = 1_500;
  const clipped = serialized.length > MAX ? `${serialized.slice(0, MAX)}\n… (truncated)` : serialized;
  return "```\n" + clipped + "\n```";
}

interface SlackDirectMessageClient {
  conversations: {
    open: (args: { users: string; return_im: boolean }) => Promise<{ channel?: { id?: string } }>;
  };
  chat: {
    postMessage: (args: any) => Promise<{ ts?: string }>;
  };
}

export async function sendSlackDirectMessage(
  client: SlackDirectMessageClient,
  options: {
    userId: string;
    text: string;
    username?: string;
    iconEmoji?: string;
    imageUrl?: string;
  },
): Promise<{ channelId: string; ts: string | undefined }> {
  const opened = await client.conversations.open({
    users: options.userId,
    return_im: true,
  });
  const channelId = opened.channel?.id;
  if (!channelId) {
    throw new Error(`Slack did not return a DM channel for user ${options.userId}`);
  }

  const result = await client.chat.postMessage({
    channel: channelId,
    text: options.text,
    ...(options.username ? { username: options.username } : {}),
    ...(options.iconEmoji ? { icon_emoji: options.iconEmoji } : {}),
    ...(options.imageUrl && !options.iconEmoji ? { icon_url: options.imageUrl } : {}),
  });

  return { channelId, ts: result.ts };
}

export async function dispatchAgentDirectivesFromSlackPost(args: {
  text: string;
  channelId: string;
  threadTs?: string;
  runContext: SlackMcpRunContext | null;
  manager?: Pick<SessionManager, "handleAgentMessage">;
}): Promise<string | null> {
  const directives = parsePureAgentDirectiveResponse(args.text);
  if (directives.length === 0) return null;

  const manager = args.manager ?? sessionManager;
  if (!manager) {
    return "Error: session manager not available; refused to post persistent-agent directive as Slack text.";
  }
  if (!args.threadTs) {
    return "Error: persistent-agent directives must target a Slack thread; refused to post directive as Slack text.";
  }
  if (!args.runContext) {
    return "Error: MCP run context missing; refused to post persistent-agent directive as Slack text.";
  }
  if (args.runContext.threadId !== args.threadTs || args.runContext.channel !== args.channelId) {
    return "Error: dispatch target does not match authenticated MCP run context; refused to post directive as Slack text.";
  }

  const caller = args.runContext.agent;
  const allowedAgents = new Set(dispatchableAgentsFor(caller));
  const disallowed = directives.find((directive) => !allowedAgents.has(directive.agentName));
  if (disallowed) {
    return `Error: ${caller} is not allowed to dispatch ${disallowed.agentName}; refused to post directive as Slack text.`;
  }

  const sourceIdentity = AGENT_IDENTITIES[caller];
  const now = Date.now();
  for (const [index, directive] of directives.entries()) {
    await manager.handleAgentMessage(
      {
        threadId: args.threadTs,
        channel: args.channelId,
        user: "mcp-internal",
        text: directive.prompt,
        ts: args.threadTs,
        command: null,
        isSelfBot: true,
        botUsername: sourceIdentity?.username,
        dedupeKey: `${args.threadTs}:mcp-slack-send:${caller}:${directive.agentName}:${index}:${now}`,
      },
      directive.agentName,
    );
  }

  return JSON.stringify({
    ok: true,
    dispatched: directives.map((directive) => directive.agentName),
    thread: args.threadTs,
  });
}

async function withMemoryStore<T>(fn: (memory: ReturnType<typeof createMemoryStore>) => Promise<T>): Promise<T> {
  const memory = createMemoryStore(MEMORY_DB_PATH);
  try {
    return await fn(memory);
  } finally {
    memory.close();
  }
}

// ---------------------------------------------------------------------------
// memory v3 read/write path (memory-system-v3.md §6, §8, §10)
//
// Two retrieval modes drive the read path: KEYED profile fetch (no vector) and
// SEMANTIC claim recall (cosine + FTS over an embedded corpus). The MCP tool
// handlers above are thin wrappers; the logic lives in these exported functions
// so tests can drive them with an in-memory store + the hashing provider, mocking
// only at the system boundary (CLAUDE.md rule 15).
// ---------------------------------------------------------------------------

/** Injected dependencies — the store, the embedding provider, and the keyed profile store. */
export interface MemoryToolDeps {
  store: MemoryStore;
  provider: EmbeddingProvider;
  profileStore: ProfileStore;
}

export interface RecallMemoryArgs {
  query: string;
  repo?: string;
  kinds?: ClaimKind[];
  entityRefs?: string[];
  limit?: number;
}

export interface RecallMemoryResult {
  /** Keyed profiles, returned verbatim (Junior-internal — never surfaced in a thread). */
  profiles: Profile[];
  /** Top-k semantic claims, ranked by cosine+FTS and weighted. */
  claims: Array<{
    id: string;
    kind: ClaimKind;
    text: string;
    score: number;
    repo: string | null;
    tags: string[];
  }>;
}

/**
 * Recall over two channels and merge (§8):
 *  1. KEYED — `entityRefs` are fetched by path from the profile store, verbatim,
 *     with no embedding. The interlocutor/workspace is ground truth.
 *  2. SEMANTIC — `query` is embedded in QUERY mode, then `recallClaims` filters
 *     by repo/kind (the WHERE) and ranks by cosine (the ORDER BY). The store never
 *     embeds — we embed at this boundary.
 */
export async function recallMemory(
  args: RecallMemoryArgs,
  deps: MemoryToolDeps,
): Promise<RecallMemoryResult> {
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 5), 1), 50);

  // 1. Keyed profile fetch — no vector. Skip refs that don't resolve to a file.
  const profiles: Profile[] = [];
  for (const ref of args.entityRefs ?? []) {
    let profile: Profile | null = null;
    try {
      profile = await deps.profileStore.fetchByEntityRef(ref);
    } catch {
      // Malformed entity_ref (bad shape / unknown kind) — skip, don't fail recall.
      profile = null;
    }
    if (profile) profiles.push(profile);
  }

  // 2. Semantic claim recall — embed the query once, run one filtered recall per
  //    kind (ClaimRecallFilters carries a single kind), then merge + re-rank.
  const [queryVector] = await deps.provider.embed([args.query], "query");
  const kindScopes: Array<ClaimKind | undefined> =
    args.kinds && args.kinds.length > 0 ? args.kinds : [undefined];

  const seen = new Set<string>();
  const merged: ClaimRecallResult[] = [];
  for (const kind of kindScopes) {
    const filters: ClaimRecallFilters = {};
    if (args.repo) filters.repo = args.repo;
    if (kind) filters.kind = kind;
    const results = await deps.store.recallClaims({
      queryVector,
      filters,
      limit,
    });
    for (const r of results) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
  }
  merged.sort((a, b) => b.score - a.score);

  return {
    profiles,
    claims: merged.slice(0, limit).map((c) => ({
      id: c.id,
      kind: c.kind,
      text: c.text,
      score: c.score,
      repo: c.repo,
      tags: c.tags,
    })),
  };
}

export interface AddMemoryArgs {
  text: string;
  kind?: ClaimKind;
  repo?: string;
  tags?: string[];
}

/**
 * Add + embed a single atomic claim (§6.1). The text is embedded in DOCUMENT
 * mode and stored with its embedding co-located; the id is a deterministic slug
 * of the text, so re-adding the same claim upserts in place rather than
 * duplicating. Returns the stored id.
 */
export async function addMemory(
  args: AddMemoryArgs,
  deps: MemoryToolDeps,
): Promise<{ id: string }> {
  const text = args.text.trim();
  if (!text) throw new Error("memory_add: `text` must be a non-empty claim");

  const kind: ClaimKind = args.kind ?? "lesson";
  const [embedding] = await deps.provider.embed([text], "document");
  const id = claimIdFromText(text);

  await deps.store.upsertClaim({
    id,
    kind,
    text,
    embedding,
    embedModel: deps.provider.model,
    dim: deps.provider.dim,
    repo: args.repo ?? null,
    tags: args.tags ?? [],
    createdAt: Date.now(),
  });

  return { id };
}

/** Deterministic claim id: a readable slug of the text + a short content hash. */
function claimIdFromText(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const hash = fnv1aHex(text);
  return slug ? `claim_${slug}_${hash}` : `claim_${hash}`;
}

/** 32-bit FNV-1a as 8-hex-char string — deterministic, dependency-free. */
function fnv1aHex(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
  slackIdentity: { username: string; iconEmoji?: string; imageUrl?: string } | null;
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
              ...(identity.imageUrl ? { imageUrl: identity.imageUrl } : {}),
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
  manager?: SessionManager,
  actionStore?: SlackActionStore,
): void {
  slack = new WebClient(botToken);
  sessionStore = store;
  worktreeManager = wtManager;
  sessionManager = manager;
  slackActionStore = actionStore;

  const handleHttpRequest = async (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (pathname === "/mcp/mongodb") {
      await handleMongoMcpRequest(req, res);
      return;
    }

    // Each request gets its own transport (stateless mode).
    // Tools are registered fresh but share the same WebClient.
    const mcpServer = new McpServer({ name: "slack-bot", version: "0.1.0" });
    registerTools(mcpServer, parseSlackMcpRunContext(req.url));

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  };
  const httpServer = createServer(handleHttpRequest);

  // Loopback only. Every consumer (spawned runners, dashboard) connects via
  // localhost, and the tools here are unauthenticated — Slack posting, memory,
  // and the WhatsApp archive must not be reachable from the network. Bind BOTH
  // loopback families: `localhost` resolves to ::1 first on common macOS/Node
  // setups, so an IPv4-only bind would refuse every existing client URL. The
  // ::1 listener is best-effort — some environments have IPv6 disabled.
  httpServer.listen(MCP_PORT, "127.0.0.1", () => {
    log.info("mcp", `Slack bot MCP server listening on 127.0.0.1:${MCP_PORT}`);
  });
  const httpServerV6 = createServer(handleHttpRequest);
  httpServerV6.on("error", (err) => {
    log.warn(
      "mcp",
      `IPv6 loopback listener unavailable (${err instanceof Error ? err.message : String(err)}) — IPv4 loopback still serving`,
    );
  });
  httpServerV6.listen(MCP_PORT, "::1", () => {
    log.info("mcp", `Slack bot MCP server listening on [::1]:${MCP_PORT}`);
  });
}
