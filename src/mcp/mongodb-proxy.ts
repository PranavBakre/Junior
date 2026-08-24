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
const MONGODB_PRECONFIGURED_CONNECTION_ID = "preconfigured";
const MONGODB_MCP_PACKAGE = "mongodb-mcp-server@2.1.0";
export const MONGODB_FIND_MAX_LIMIT = 100;
const MONGODB_CONNECTION_ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const MONGODB_TOOL_NAMES = [
  "aggregate",
  "collection-schema",
  "count",
  "find",
  "list-collections",
  "list-databases",
] as const;

export interface MongoConnectionConfig {
  id: string;
  connectionString: string;
}

interface MongoBackend {
  client: Client;
  transport: StdioClientTransport;
}

type MongoBackendClient = Pick<Client, "callTool" | "listTools">;
type MongoBackendProvider = (connectionId: string) => Promise<{ client: MongoBackendClient }>;

const backends = new Map<string, Promise<MongoBackend>>();
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
  configuredConnections: string[] = configuredMongoConnectionIds(),
): Server {
  const server = new Server(
    { name: "mongodb", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (configuredConnections.length === 0) {
      throw new Error("No MongoDB MCP connections are configured");
    }
    const byConnection = await Promise.all(configuredConnections.map(async (connectionId) => {
      const { client } = await backendProvider(connectionId);
      return { connectionId, tools: (await client.listTools()).tools };
    }));
    armIdleTimer();
    const union = new Map<string, (typeof byConnection)[number]["tools"][number]>();
    for (const { tools } of byConnection) {
      for (const tool of tools) {
        if (isAllowedMongoTool(tool.name) && !union.has(tool.name)) union.set(tool.name, tool);
      }
    }
    return {
      tools: [...union.values()].map((tool) => addConnectionToSchema(tool, configuredConnections)),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    if (!isAllowedMongoTool(name)) {
      return mongoProxyError(`tool "${name}" is not available through the read-only proxy.`);
    }
    if (!runContext) {
      return mongoProxyError("MongoDB MCP run context missing; refused to proxy request.");
    }

    try {
      const args = { ...(rawArgs ?? {}) };
      const connectionId = args.connection;
      delete args.connection;
      if (typeof connectionId !== "string" || !configuredConnections.includes(connectionId)) {
        return mongoProxyError(
          `connection must be one of the configured connections: ${configuredConnections.join(", ") || "none"}.`,
        );
      }
      const validation = validateMongoToolArguments(name, args ?? {});
      if (validation) return mongoProxyError(validation);
      const { client } = await backendProvider(connectionId);
      armIdleTimer();
      return await client.callTool(
        {
          name,
          arguments: {
            ...(args ?? {}),
            // mongodb-mcp-server v2 registers an env-configured URI under
            // this fixed ID. Keep that upstream implementation detail out of
            // prompts and refuse agent-supplied connection selection.
            connectionId: MONGODB_PRECONFIGURED_CONNECTION_ID,
          },
        },
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

function hideMongoConnectionId<T extends { name: string; description?: string; inputSchema: Record<string, unknown> }>(
  tool: T,
): T {
  const schema = tool.inputSchema;
  let properties = schema.properties && typeof schema.properties === "object"
    ? { ...(schema.properties as Record<string, unknown>) }
    : undefined;
  if (properties) delete properties.connectionId;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => name !== "connectionId")
    : schema.required;
  if (tool.name === "find") {
    properties ??= {};
    const upstreamLimit = properties.limit && typeof properties.limit === "object"
      ? properties.limit as Record<string, unknown>
      : {};
    const upstreamMinimum = typeof upstreamLimit.minimum === "number"
      ? upstreamLimit.minimum
      : 1;
    const upstreamMaximum = typeof upstreamLimit.maximum === "number"
      ? upstreamLimit.maximum
      : MONGODB_FIND_MAX_LIMIT;
    properties.limit = {
      ...upstreamLimit,
      type: "integer",
      minimum: Math.max(1, upstreamMinimum),
      maximum: Math.min(MONGODB_FIND_MAX_LIMIT, upstreamMaximum),
      description: typeof upstreamLimit.description === "string"
        ? `${upstreamLimit.description}. Must be between 1 and ${MONGODB_FIND_MAX_LIMIT}.`
        : `Required bounded page size; results never exceed ${MONGODB_FIND_MAX_LIMIT} documents.`,
    };
    const findRequired = Array.isArray(required) ? [...required] : [];
    if (!findRequired.includes("limit")) findRequired.push("limit");
    return {
      ...tool,
      description: `${tool.description ?? ""} Results are bounded to an explicit limit of 100 or fewer; use a separate export workflow for complete datasets.`,
      inputSchema: {
        ...schema,
        properties,
        required: findRequired,
      },
    };
  }
  return {
    ...tool,
    inputSchema: {
      ...schema,
      ...(properties ? { properties } : {}),
      ...(required ? { required } : {}),
    },
  };
}

function validateMongoToolArguments(
  name: string,
  args: Record<string, unknown>,
): string | null {
  if (name !== "find") return null;
  const limit = args.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MONGODB_FIND_MAX_LIMIT) {
    return `find requires an explicit integer limit from 1 to ${MONGODB_FIND_MAX_LIMIT}; broad or capped partial results are refused. Use an approved export workflow for complete datasets.`;
  }
  return null;
}

export async function closeMongoMcpBackend(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const active = [...backends.values()];
  backends.clear();
  await Promise.all(active.map(async (current) => {
    const { client, transport } = await current.catch(() => ({ client: null, transport: null }));
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }));
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

export function configuredMongoConnections(): MongoConnectionConfig[] {
  const raw = process.env.MDB_MCP_CONNECTIONS?.trim();
  if (!raw) {
    const legacy = process.env.MDB_MCP_CONNECTION_STRING?.trim();
    return legacy ? [{ id: "preconfigured", connectionString: legacy }] : [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MDB_MCP_CONNECTIONS must be a JSON object mapping connection IDs to MongoDB URIs");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MDB_MCP_CONNECTIONS must be a JSON object mapping connection IDs to MongoDB URIs");
  }

  const connections = Object.entries(parsed as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => {
      if (!MONGODB_CONNECTION_ID_PATTERN.test(id)) {
        throw new Error(`Invalid MongoDB MCP connection ID "${id}"`);
      }
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`MongoDB MCP connection "${id}" must have a non-empty URI`);
      }
      return { id, connectionString: value.trim() };
    });
  if (connections.length === 0) {
    throw new Error("MDB_MCP_CONNECTIONS must configure at least one connection");
  }
  return connections;
}

export function configuredMongoConnectionIds(): string[] {
  return configuredMongoConnections().map(({ id }) => id);
}

function getMongoBackend(connectionId: string): Promise<MongoBackend> {
  let current = backends.get(connectionId);
  if (!current) {
    const connection = configuredMongoConnections().find(({ id }) => id === connectionId);
    if (!connection) throw new Error(`MongoDB MCP connection "${connectionId}" is not configured`);
    current = startMongoBackend(connection).catch((err) => {
      backends.delete(connectionId);
      throw err;
    });
    backends.set(connectionId, current);
  }
  armIdleTimer();
  return current;
}

async function startMongoBackend(connection: MongoConnectionConfig): Promise<MongoBackend> {
  const transport = new StdioClientTransport({
    command: resolve(
      import.meta.dirname ?? ".",
      "../../bin/junior-mcp-stdio-wrapper.js",
    ),
    args: ["--", "npx", "-y", MONGODB_MCP_PACKAGE, "--readOnly"],
    env: {
      ...process.env,
      MDB_MCP_CONNECTIONS: "",
      MDB_MCP_CONNECTION_STRING: connection.connectionString,
    },
    stderr: "pipe",
  });
  transport.onerror = (err) => {
    log.warn("mongodb-mcp", `backend error: ${err.message}`);
  };
  transport.onclose = () => {
    backends.delete(connection.id);
    log.info("mongodb-mcp", `${connection.id} backend closed`);
  };

  const client = new Client(
    { name: `junior-mongodb-${connection.id}-proxy`, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  log.info("mongodb-mcp", `${connection.id} backend started pid=${transport.pid ?? "unknown"}`);
  return { client, transport };
}

function addConnectionToSchema<T extends { name: string; description?: string; inputSchema: Record<string, unknown> }>(
  tool: T,
  connections: string[],
): T {
  const sanitized = hideMongoConnectionId(tool);
  const schema = sanitized.inputSchema;
  const properties = schema.properties && typeof schema.properties === "object"
    ? { ...(schema.properties as Record<string, unknown>) }
    : {};
  properties.connection = {
    type: "string",
    enum: connections,
    description: "Configured MongoDB connection for this request.",
  };
  const required = Array.isArray(schema.required) ? [...schema.required] : [];
  if (!required.includes("connection")) required.unshift("connection");
  return {
    ...sanitized,
    inputSchema: { ...schema, type: "object", properties, required },
  };
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
