import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
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

type MongoBackendClient = Pick<Client, "callTool" | "listTools">;
type MongoBackendProvider = () => Promise<{ client: MongoBackendClient }>;

let backend: Promise<MongoBackend> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export async function handleMongoMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const runContext = parseSlackMcpRunContext(req.url);
  const mcpServer = createMongoProxyServer(runContext);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}

/**
 * Mirror the backend's current tool contracts instead of replacing them with a
 * generic record schema. Strict MCP clients reject legitimate Mongo arguments
 * (including nested `filter` objects) when tools/list declares no properties.
 * The allowlist remains local so upstream additions can never expand access.
 */
export function createMongoProxyServer(
  runContext: SlackMcpRunContext | null,
  backendProvider: MongoBackendProvider = getMongoBackend,
): Server {
  const server = new Server(
    { name: "mongodb", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { client } = await backendProvider();
    armIdleTimer();
    const { tools } = await client.listTools();
    return {
      tools: tools.filter((tool) => isAllowedMongoTool(tool.name)),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!isAllowedMongoTool(name)) {
      return mongoProxyError(`tool "${name}" is not available through the read-only proxy.`);
    }
    if (!runContext) {
      return mongoProxyError("MongoDB MCP run context missing; refused to proxy request.");
    }

    try {
      const { client } = await backendProvider();
      armIdleTimer();
      return await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: MONGODB_PROXY_REQUEST_TIMEOUT_MS },
      ) as CallToolResult;
    } catch (err) {
      return mongoProxyError(
        `MongoDB MCP proxy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return server;
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

function isAllowedMongoTool(name: string): name is typeof MONGODB_TOOL_NAMES[number] {
  return (MONGODB_TOOL_NAMES as readonly string[]).includes(name);
}

function mongoProxyError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `Error: ${message}`,
    }],
  };
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
