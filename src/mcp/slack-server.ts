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
import { registerTool } from "./register-tool.ts";
import { registerWhatsAppTools } from "./whatsapp-tools.ts";
import { handleMongoMcpRequest } from "./mongodb-proxy.ts";
import { registerPendingApproval } from "./approval.ts";
import { prepareSlackResponseWithActions, type SlackActionButtonSpec } from "../slack/formatting.ts";
import { buildActionBlocks, splitActionMessageText } from "../slack/responder.ts";
import type { SlackActionStore } from "../slack/action-store.ts";
import { disableAgentActionMessages } from "../slack/action-buttons.ts";
import type { PipelineToolRuntime } from "../pipelines/tools.ts";
import {
  pipelineGetState,
  pipelineDispatchAgent,
  pipelineRegisterPr,
  pipelineReportOutcome,
  pipelineRunCheck,
  pipelineStartRun,
  pipelineWriteArtifact,
} from "../pipelines/tools.ts";
import {
  postGitHubReview,
  readGitHubReviewState,
} from "../github/review-comments.ts";
import {
  getRunbook,
  searchRunbooks,
} from "../runbooks/registry.ts";
import { selectRunbook } from "../runbooks/selector.ts";
import type { RunbookRisk } from "../runbooks/types.ts";
import type { RunbookRunEvidence } from "../runbooks/evidence.ts";
import {
  recordSuccessfulExecution as promotionRecordExecution,
  checkPromotionThreshold as promotionCheckThreshold,
  listCandidates as promotionListCandidates,
  getCandidate as promotionGetCandidate,
} from "../runbooks/promotion.ts";
import {
  renderRunbookTemplate,
  generateProposalReport,
  type AuthoringContext as AuthoringContextType,
} from "../runbooks/authoring.ts";
import { classifyReusablePattern } from "../runbooks/classifier.ts";
import {
  createRunbookPr,
  type PrCreationResult as PrCreationResultType,
} from "../runbooks/github.ts";

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
let pipelineRuntime: PipelineToolRuntime | undefined;

/** Inject pipeline tool runtime (store + mode). Called from boot or tests. */
export function setPipelineRuntime(runtime: PipelineToolRuntime | undefined): void {
  pipelineRuntime = runtime;
}

function registerTools(server: McpServer, runContext: SlackMcpRunContext | null = null) {
  registerWhatsAppTools(server, {
    runContext,
    // Deny-by-default until the SessionManager/SessionStore are wired in:
    // without them neither the admin roster nor the live participant list can
    // be consulted, and the archive is personal data. isExplicitAdmin (not
    // isAdmin) so the dev open-mode fallback — no roster configured promotes
    // everyone — can never unlock the archive.
    isAdmin: (userId) => sessionManager?.isExplicitAdmin(userId) ?? Promise.resolve(false),
    getSession: async (threadId) => {
      const session = await sessionStore?.get(threadId);
      return session
        ? { channel: session.channel, humanParticipants: session.humanParticipants }
        : null;
    },
  });
  registerTool(
    server,
    "github_read_pr_review_state",
    {
      description:
        "Read a PR head, reviews, and inline review comments through fixed GET-only GitHub endpoints. " +
        "Use this instead of gh api when checking prior findings or verifying review comment counts.",
      inputSchema: {
        owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        pr_number: z.number().int().positive(),
        review_id: z.number().int().positive().optional(),
      },
    },
    async ({ owner, repo, pr_number, review_id }) => {
      const result = await readGitHubReviewState(runContext, {
        owner,
        repo,
        prNumber: pr_number,
        ...(review_id === undefined ? {} : { reviewId: review_id }),
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
  registerTool(
    server,
    "github_post_review",
    {
      description:
        "Post one idempotent GitHub COMMENT review at an exact PR head. " +
        "This is the only GitHub write available to read-only reviewers: it can add a review body and inline comments, " +
        "but cannot approve, request changes, merge, push, edit code, or call arbitrary endpoints. " +
        "Use this instead of gh/gh api for review writes.",
      inputSchema: {
        owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        pr_number: z.number().int().positive(),
        head_sha: z.string().regex(/^[a-f0-9]{40}$/i),
        body: z.string().min(1).max(20_000),
        idempotency_key: z.string().min(1).max(200),
        comments: z
          .array(
            z.object({
              path: z.string().min(1).max(1_024),
              line: z.number().int().positive(),
              side: z.enum(["LEFT", "RIGHT"]),
              body: z.string().min(1).max(10_000),
              start_line: z.number().int().positive().optional(),
              start_side: z.enum(["LEFT", "RIGHT"]).optional(),
            }),
          )
          .max(100)
          .optional(),
      },
    },
    async ({
      owner,
      repo,
      pr_number,
      head_sha,
      body,
      idempotency_key,
      comments,
    }) => {
      const result = await postGitHubReview(runContext, {
        owner,
        repo,
        prNumber: pr_number,
        headSha: head_sha,
        body,
        idempotencyKey: idempotency_key,
        comments: (comments ?? []).map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: comment.body,
          ...(comment.start_line !== undefined
            ? { startLine: comment.start_line }
            : {}),
          ...(comment.start_side !== undefined
            ? { startSide: comment.start_side }
            : {}),
        })),
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
    "agent_dispatch",
    {
      description:
        "Durably delegate to or hand off ownership to a registered Junior agent. With an active assignment this creates a typed successor in the current run; outside the durable runtime it falls back to legacy internal dispatch.",
      inputSchema: {
        agent_name: z.string().describe("Target persistent agent name, e.g. review, reproducer"),
        prompt: z.string().describe("Prompt to send to the agent"),
        mode: z.enum(["delegate", "handoff"]).describe("delegate resumes the caller after the child completes; handoff transfers ownership."),
        reason: z.string().optional().describe("Why this agent/ownership transition is needed"),
        idempotency_key: z.string().min(1).describe("Stable semantic key reused on retries"),
        to_phase: z.string().optional().describe("Optional legal controller phase for a handoff"),
        evidence_refs: z.array(z.string()).optional().describe("Durable evidence references supporting the transition"),
        artifact_refs: z.array(z.string()).optional().describe("Durable artifact references inherited by the child assignment"),
        acceptance_criteria: z.array(z.string()).optional().describe("Acceptance criteria for the child assignment"),
        channel_id: z.string().optional().describe("Deprecated; authenticated channel is derived from signed context"),
        thread_ts: z.string().optional().describe("Deprecated; authenticated thread is derived from signed context"),
        user_id: z.string().optional().describe("User id to record on the synthetic internal event (default: mcp-internal)"),
        trigger_ts: z.string().optional().describe("Slack message timestamp that caused the dispatch. Defaults to thread_ts."),
      },
    },
    async ({ agent_name, prompt, mode, reason, idempotency_key, to_phase, evidence_refs, artifact_refs, acceptance_criteria, channel_id, thread_ts, user_id, trigger_ts }) => {
      if (!sessionManager) {
        return { content: [{ type: "text" as const, text: "Error: session manager not available" }] };
      }
      const targetAgent = agent_name.trim();
      if (!runContext) {
        return { content: [{ type: "text" as const, text: "Error: MCP run context missing; cannot authenticate caller" }] };
      }
      const resolvedThread = thread_ts ?? runContext.threadId;
      const resolvedChannel = channel_id ?? runContext.channel;
      if (runContext.threadId !== resolvedThread || runContext.channel !== resolvedChannel) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: dispatch target does not match authenticated MCP run context",
            },
          ],
        };
      }

      const session = await sessionManager.getSession(runContext.threadId);
      const callerInvocation = runContext.agent === "default" || runContext.agent === "lead"
        ? session?.activePipelineInvocation
        : session?.agentSessions?.[runContext.agent]?.activePipelineInvocation;
      if (pipelineRuntime && callerInvocation) {
        return pipelineDispatchAgent(pipelineRuntime, runContext, {
          target_agent: targetAgent,
          objective: prompt,
          mode,
          reason: reason?.trim() || `${runContext.agent} dispatched ${targetAgent}`,
          idempotency_key: idempotency_key.trim(),
          to_phase,
          evidence_refs,
          artifact_refs,
          acceptance_criteria,
        });
      }
      if (pipelineRuntime && session?.activeRunId) {
        const active = await pipelineRuntime.store.getRun(session.activeRunId);
        if (active && active.status !== "terminal") {
          return {
            content: [{
              type: "text" as const,
              text: "Error: active durable run has no assignment owned by this caller; refusing legacy dispatch",
            }],
            isError: true,
          };
        }
      }

      // Legacy, non-durable fallback retains the public identity/allow-table
      // checks. Durable dispatch above is authorized by the trusted catalog.
      if (!isPersistentAgent(targetAgent)) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: unknown legacy agent "${targetAgent}". Use agent_search to find registered agents.`,
          }],
        };
      }
      const caller = runContext.agent;
      const allowed = dispatchableAgentsFor(caller);
      if (!allowed.includes(targetAgent)) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${caller} is not allowed to dispatch ${targetAgent}. Allowed: ${allowed.join(", ") || "(none)"}.`,
          }],
        };
      }

      await sessionManager.handleAgentMessage(
        {
          threadId: resolvedThread,
          channel: resolvedChannel,
          user: user_id ?? "mcp-internal",
          text: prompt,
          ts: trigger_ts ?? resolvedThread,
          command: null,
          isSelfBot: true,
          botUsername: AGENT_IDENTITIES[caller]?.username,
          dedupeKey: `${resolvedThread}:mcp:${runContext.agent}:${targetAgent}:${idempotency_key}`,
        },
        targetAgent,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, agent: targetAgent, thread: resolvedThread, mode, durable: false }),
          },
        ],
      };
    },
  );

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
    "runbook_search",
    {
      description:
        "Search Junior runbook definitions by query, tags, owner agent, or risk level.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive text to match against runbook name, description, or tags"),
        tags: z.array(z.string()).optional().describe("Filter by tag (OR match)"),
        owner_agent: z.string().optional().describe("Filter by owning agent name"),
        risk: z.string().optional().describe("Filter by risk level"),
        limit: z.number().optional().describe("Maximum results to return (default 25, max 100)"),
      },
    },
    async ({ query, tags, owner_agent, risk, limit }) => {
      const results = searchRunbooks({
        query,
        tags,
        ownerAgent: owner_agent,
        risk,
        limit: Math.min(limit ?? 25, 100),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ runbooks: results }, null, 2),
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "runbook_get",
    {
      description:
        "Get a runbook definition by name, including its full prompt, inputs, verification, and provenance.",
      inputSchema: {
        name: z.string().describe("Runbook name (kebab-case)"),
      },
    },
    async ({ name }) => {
      const def = getRunbook(name);
      if (!def) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `runbook "${name}" not found` }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(def, null, 2),
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "runbook_select",
    {
      description:
        "Select the best matching runbook for a natural-language request, bind inputs from context, and return execution evidence. Falls back to procedure-memory guidance when no runbook matches.",
      inputSchema: {
        request: z.string().describe("Natural-language description of the task"),
        context: z.record(z.string()).optional().describe("Key-value pairs from thread context for input binding"),
        owner_agent: z.string().optional().describe("Filter to runbooks owned by this agent"),
        risk_ceiling: z.string().optional().describe("Exclude runbooks above this risk level"),
      },
    },
    async ({ request, context, owner_agent, risk_ceiling }) => {
      const result = selectRunbook(request, context ?? {}, {
        ownerAgent: owner_agent,
        riskCeiling: risk_ceiling as RunbookRisk | undefined,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "promotion_candidates",
    {
      description:
        "List promotion candidates — repeated tasks that may warrant a reviewed runbook.",
      inputSchema: {
        status: z.string().optional().describe("Filter by status: tracking, proposed, accepted, rejected, archived"),
        min_occurrences: z.number().optional().describe("Minimum occurrence count (default 1)"),
        limit: z.number().optional().describe("Maximum results (default 25, max 100)"),
      },
    },
    async ({ status, min_occurrences, limit }) => {
      const results = promotionListCandidates({
        status,
        minOccurrences: min_occurrences,
      });
      const capped = results.slice(0, Math.min(limit ?? 25, 100));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ candidates: capped }, null, 2),
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "promotion_record",
    {
      description:
        "Record a completed run's evidence for promotion tracking. Returns the candidate and whether it should be proposed as a runbook.",
      inputSchema: {
        evidence: z.object({
          runId: z.string(),
          runbookName: z.string(),
          contentDigest: z.string(),
          ownerAgent: z.string(),
          risk: z.string(),
          boundInputs: z.record(z.string()),
          status: z.string(),
          startedAt: z.number(),
          completedAt: z.number().optional(),
          intentFingerprint: z.string(),
        }).describe("RunbookRunEvidence from a completed run"),
      },
    },
    async ({ evidence }) => {
      promotionRecordExecution(evidence as RunbookRunEvidence);
      const check = promotionCheckThreshold(evidence.intentFingerprint);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              fingerprint: evidence.intentFingerprint,
              shouldPropose: check.shouldPropose,
              reason: check.reason,
              candidate: check.candidate,
            }, null, 2),
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "runbook_propose",
    {
      description:
        "Generate a runbook proposal from a promotion candidate. Returns rendered .runbook.md content, a structured proposal report, and a dry-run PR result.",
      inputSchema: {
        fingerprint: z.string().describe("Intent fingerprint from a promotion candidate"),
        dry_run: z.boolean().optional().describe("Whether to skip actual PR creation (default true)"),
        inferred_inputs: z.array(z.object({
          name: z.string(),
          type: z.string(),
          required: z.boolean(),
          description: z.string().optional(),
        })).optional().describe("Inferred typed inputs for the runbook"),
        inferred_capabilities: z.array(z.string()).optional().describe("Inferred capability bundles"),
        inferred_assertions: z.array(z.string()).optional().describe("Inferred verification assertions"),
      },
    },
    async ({ fingerprint, dry_run, inferred_inputs, inferred_capabilities, inferred_assertions }) => {
      const candidate = promotionGetCandidate(fingerprint);
      if (!candidate) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `no candidate found for fingerprint "${fingerprint}"` }) }],
        };
      }

      const context: AuthoringContextType = {
        candidate,
        executionEvidence: [],
        inferredInputs: inferred_inputs,
        inferredCapabilities: inferred_capabilities,
        inferredVerificationAssertions: inferred_assertions,
      };

      const rendered = renderRunbookTemplate(context);
      const classification = classifyReusablePattern(
        candidate.normalizedIntent,
        candidate.ownerAgent,
        candidate.risk,
        candidate.capabilities,
        candidate.occurrenceCount,
      );
      const report = generateProposalReport(context, rendered, classification);

      let pr: PrCreationResultType | undefined;
      if (rendered.ok) {
        pr = await createRunbookPr(rendered, report, { dryRun: dry_run ?? true });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ rendered, report, pr }, null, 2),
        }],
      };
    },
  );

  registerTool(
    server,
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

  registerTool(
    server,
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

  registerTool(
    server,
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

  // -------------------------------------------------------------------------
  // Pipeline control-plane tools (Phase 4). Authenticated via MCP run context.
  // When PIPELINE_RUNTIME_MODE=off, mutating tools return disabled; get_state
  // still answers with empty/not-found.
  // -------------------------------------------------------------------------

  registerTool(
    server,
    "pipeline_start_run",
    {
      description:
        "Deliberately upgrade the authenticated current Slack thread into a durable product or bug pipeline. " +
        "Only trusted orchestrators may call this. Text alone never starts a pipeline; channel, thread, agent, and source turn come from signed runtime context.",
      inputSchema: {
        kind: z.enum(["product", "bug"]),
        start_kind: z.enum(["pm", "build", "debug", "reproducer"]),
        objective: z.string().min(1).max(20_000),
        reason: z.string().min(1).max(2_000),
        idempotency_key: z.string().min(1).max(200),
        repo_refs: z.array(z.string().min(1).max(200)).max(20).optional(),
        acceptance_criteria: z
          .array(z.string().min(1).max(2_000))
          .max(50)
          .optional(),
        bug_mode: z
          .enum(["expected-behavior", "focused-debug", "full-investigation"])
          .optional(),
        required_workstreams: z
          .array(z.enum(["backend", "frontend"]))
          .min(1)
          .max(2)
          .optional()
          .describe(
            "Product build scope chosen by the orchestrator. Prefer this over keyword inference.",
          ),
      },
    },
    async (args) => {
      if (!pipelineRuntime) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: "pipeline runtime disabled (PIPELINE_RUNTIME_MODE=off)",
              }),
            },
          ],
          isError: true,
        };
      }
      return pipelineStartRun(pipelineRuntime, runContext, args);
    },
  );

  registerTool(
    server,
    "pipeline_get_state",
    {
      description:
        "Read the durable pipeline run state for the current Slack thread (or a run_id). " +
        "Returns phase, assignments, outbox, and registered GitHub resources. Safe when pipeline mode is off (empty).",
      inputSchema: {
        run_id: z.string().optional().describe("Pipeline run id (defaults to active run for this thread)"),
      },
    },
    async ({ run_id }) => {
      if (!pipelineRuntime) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                runtimeMode: "off",
                run: null,
                message: "pipeline runtime not configured",
              }),
            },
          ],
        };
      }
      return pipelineGetState(pipelineRuntime, runContext, { run_id });
    },
  );

  registerTool(
    server,
    "pipeline_report_outcome",
    {
      description:
        "Settle the caller's exact signed assignment with continue_self|wait|escalate|complete. Use agent_dispatch for every agent-to-agent transition. " +
        "Runtime validates authority, state version, edges, and budgets; returns an explicit receipt.",
      inputSchema: {
        outcome: z
          .record(z.string(), z.unknown())
          .describe("AgentOutcome object with assignmentId, expectedRunVersion, action, status, reason, evidenceRefs, artifactRefs, blockers, checks, progressFingerprint, plus wait when action=wait"),
        to_phase: z.string().optional().describe("Optional phase advance"),
        idempotency_key: z.string().optional().describe("Duplicate-safe idempotency key"),
      },
    },
    async ({ outcome, to_phase, idempotency_key }) => {
      if (!pipelineRuntime) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: "pipeline runtime disabled (PIPELINE_RUNTIME_MODE=off)",
              }),
            },
          ],
          isError: true,
        };
      }
      return pipelineReportOutcome(pipelineRuntime, runContext, {
        outcome,
        to_phase,
        idempotency_key,
      });
    },
  );

  registerTool(
    server,
    "pipeline_write_artifact",
    {
      description:
        "Write a pipeline-owned artifact under data/pipelines/<runId>/ (or an assignment-registered path). " +
        "Path traversal outside those roots is rejected.",
      inputSchema: {
        path: z.string().describe("Relative path under the run artifact directory"),
        content: z.string().describe("File contents"),
        run_id: z.string().optional(),
        assignment_id: z.string().optional(),
      },
    },
    async (args) => {
      if (!pipelineRuntime) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: "pipeline runtime disabled (PIPELINE_RUNTIME_MODE=off)",
              }),
            },
          ],
          isError: true,
        };
      }
      return pipelineWriteArtifact(pipelineRuntime, runContext, args);
    },
  );

  registerTool(
    server,
    "pipeline_register_pr",
    {
      description:
        "Register a GitHub PR created for this pipeline run with exact owner/repo/number/role/workstream/head SHA. " +
        "Required before completing a PR-opening phase when GitHub tracking is enabled.",
      inputSchema: {
        run_id: z.string(),
        assignment_id: z.string(),
        owner: z.string(),
        repo: z.string(),
        number: z.number(),
        role: z.enum(["candidate", "dev-pr", "main-pr", "dependency", "review-target"]),
        workstream_key: z.string(),
        expected_head_sha: z.string(),
        attempt_id: z.string().optional().nullable(),
      },
    },
    async (args) => {
      if (!pipelineRuntime) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: "pipeline runtime disabled (PIPELINE_RUNTIME_MODE=off)",
              }),
            },
          ],
          isError: true,
        };
      }
      return pipelineRegisterPr(pipelineRuntime, runContext, args);
    },
  );

  registerTool(
    server,
    "pipeline_run_check",
    {
      description:
        "Run an allowlisted verification check through the pipeline-owned runner and record evidence. " +
        "Does not expose arbitrary shell. Currently records stub evidence with the given status.",
      inputSchema: {
        assignment_id: z.string(),
        check_name: z
          .string()
          .describe("Allowlisted check name: typecheck|unit-test|lint|build|integration-test"),
        run_id: z.string().optional(),
        command: z.string().optional().describe("Recorded command label (not executed as shell)"),
        status: z.enum(["passed", "failed", "skipped"]).optional(),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
      },
    },
    async (args) => {
      if (!pipelineRuntime) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: "pipeline runtime disabled (PIPELINE_RUNTIME_MODE=off)",
              }),
            },
          ],
          isError: true,
        };
      }
      return pipelineRunCheck(pipelineRuntime, runContext, args);
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
  /** With `repo`, also include repo-less (global) claims. See ClaimRecallFilters. */
  repoIncludeGlobal?: boolean;
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
    if (args.repo) {
      filters.repo = args.repo;
      if (args.repoIncludeGlobal) filters.repoIncludeGlobal = true;
    }
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
  pipeline?: PipelineToolRuntime,
): void {
  slack = new WebClient(botToken);
  sessionStore = store;
  worktreeManager = wtManager;
  sessionManager = manager;
  slackActionStore = actionStore;
  if (pipeline) {
    pipelineRuntime = pipeline;
  }

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
