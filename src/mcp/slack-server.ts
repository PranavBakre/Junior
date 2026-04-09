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
import { readFile } from "fs/promises";
import { log } from "../logger.ts";

const MCP_PORT = Number(process.env.MCP_PORT ?? "3456");

let slack: WebClient;

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
      },
    },
    async ({ text, channel_id, thread_ts, reply_broadcast }) => {
      const result = reply_broadcast && thread_ts
        ? await slack.chat.postMessage({ channel: channel_id, text, thread_ts, reply_broadcast: true })
        : thread_ts
          ? await slack.chat.postMessage({ channel: channel_id, text, thread_ts })
          : await slack.chat.postMessage({ channel: channel_id, text });
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
}

/**
 * Start the shared MCP server. Call once from Junior's main process.
 */
export function startMcpServer(botToken: string): void {
  slack = new WebClient(botToken);

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
