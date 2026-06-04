import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { log } from "../logger.ts";
import { parseSlackMcpRunContext, type SlackMcpRunContext } from "./context.ts";

const MONGODB_PROXY_IDLE_TTL_MS = Number(process.env.MONGODB_MCP_PROXY_IDLE_TTL_MS ?? "600000");
const MONGODB_PROXY_REQUEST_TIMEOUT_MS = Number(process.env.MONGODB_MCP_PROXY_REQUEST_TIMEOUT_MS ?? "120000");
const MONGODB_TOOL_NAMES = [
  "aggregate",
  "collection-schema",
  "count",
  "find",
  "list-collections",
  "list-databases",
] as const;

interface MongoBackend {
  client: Client;
  transport: StdioClientTransport;
}

let backend: Promise<MongoBackend> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export async function handleMongoMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const runContext = parseSlackMcpRunContext(req.url);
  const mcpServer = new McpServer({ name: "mongodb", version: "0.1.0" });
  registerMongoProxyTools(mcpServer, runContext);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}

export async function closeMongoMcpBackend(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const current = backend;
  backend = null;
  if (!current) return;
  const { client, transport } = await current.catch(() => ({ client: null, transport: null }));
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
}

function registerMongoProxyTools(
  server: McpServer,
  runContext: SlackMcpRunContext | null,
): void {
  for (const name of MONGODB_TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: `Proxy to Junior's shared read-only MongoDB MCP backend (${name}).`,
        inputSchema: z.record(z.string(), z.unknown()),
      },
      async (args) => {
        if (!runContext) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: "Error: MongoDB MCP run context missing; refused to proxy request.",
            }],
          };
        }

        try {
          const { client } = await getMongoBackend();
          armIdleTimer();
          const result = await client.callTool(
            { name, arguments: args },
            undefined,
            { timeout: MONGODB_PROXY_REQUEST_TIMEOUT_MS },
          );
          return result as CallToolResult;
        } catch (err) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: `MongoDB MCP proxy error: ${err instanceof Error ? err.message : String(err)}`,
            }],
          };
        }
      },
    );
  }
}

function getMongoBackend(): Promise<MongoBackend> {
  if (!backend) backend = startMongoBackend();
  armIdleTimer();
  return backend;
}

async function startMongoBackend(): Promise<MongoBackend> {
  const transport = new StdioClientTransport({
    command: resolve(
      import.meta.dirname ?? ".",
      "../../bin/junior-mcp-stdio-wrapper.js",
    ),
    args: ["--", "npx", "-y", "mongodb-mcp-server@latest", "--readOnly"],
    env: {
      ...process.env,
      MDB_MCP_CONNECTION_STRING: process.env.MDB_MCP_CONNECTION_STRING ?? "",
    },
    stderr: "pipe",
  });
  transport.onerror = (err) => {
    log.warn("mongodb-mcp", `backend error: ${err.message}`);
  };
  transport.onclose = () => {
    backend = null;
    log.info("mongodb-mcp", "backend closed");
  };

  const client = new Client(
    { name: "junior-mongodb-mcp-proxy", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  log.info("mongodb-mcp", `backend started pid=${transport.pid ?? "unknown"}`);
  return { client, transport };
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeMongoMcpBackend().catch((err) => {
      log.warn("mongodb-mcp", `idle close failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, MONGODB_PROXY_IDLE_TTL_MS);
  idleTimer.unref?.();
}
