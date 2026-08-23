import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "../logger.ts";
import { parseSlackMcpRunContext, type SlackMcpRunContext } from "./context.ts";
import { MixpanelOAuthProvider } from "./mixpanel-oauth.ts";

export type MixpanelRegion = "us" | "eu" | "in";

const REGION_URLS: Record<MixpanelRegion, string> = {
  us: "https://mcp.mixpanel.com/mcp",
  eu: "https://mcp-eu.mixpanel.com/mcp",
  in: "https://mcp-in.mixpanel.com/mcp",
};
const MIXPANEL_PROXY_IDLE_TTL_MS = Number(process.env.MIXPANEL_MCP_PROXY_IDLE_TTL_MS ?? "600000");
const MIXPANEL_PROXY_REQUEST_TIMEOUT_MS = Number(process.env.MIXPANEL_MCP_PROXY_REQUEST_TIMEOUT_MS ?? "120000");

// Feature-metrics is a read path. Fail closed when Mixpanel adds new tools;
// write-capable tools need a separate human-gated capability before exposure.
const READ_ONLY_TOOLS = new Set([
  "Run-Query",
  "Get-Query-Schema",
  "Get-Report",
  "Display-Query",
  "List-Dashboards",
  "Get-Dashboard",
  "Get-Business-Context",
  "Get-Projects",
  "List-Organizations",
  "Get-Events",
  "List-Properties",
  "Get-Property-Values",
  "Search-Entities",
  "Get-Issues",
  "Get-Lexicon-URL",
  "Find-Duplicate-Groups",
  "Get-Custom-Property",
  "Get-Cohort",
  "List-Cohorts",
  "Describe-Cohort-Schema",
  "Get-Lookup-Table",
  "Get-Metric",
  "List-Metrics",
  "Get-User-Replays-Data",
  "List-Experiments",
  "Get-Experiment",
  "Get-Experiment-Setup-Guidance",
  "Get-Experiment-Results-Interpretation-Guidance",
  "Explain-Experiment-Health-Check",
  "Run-Experiment-Pre-Launch-Checks",
  "Search-Prior-Experiments",
  "List-Feature-Flags",
  "Get-Feature-Flag",
  "Get-Feature-Flag-Setup-Guidance",
  "Get-Feature-Flag-Lifecycle-Guidance",
]);

type MixpanelBackendClient = Pick<Client, "callTool" | "listTools" | "close">;
type MixpanelBackendProvider = (region: MixpanelRegion) => Promise<{ client: MixpanelBackendClient }>;
interface MixpanelBackend {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

const backends = new Map<MixpanelRegion, Promise<MixpanelBackend>>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export async function handleMixpanelMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = createMixpanelProxyServer(parseSlackMcpRunContext(req.url));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function createMixpanelProxyServer(
  runContext: SlackMcpRunContext | null,
  backendProvider: MixpanelBackendProvider = getMixpanelBackend,
  configuredRegions: MixpanelRegion[] = configuredMixpanelRegions(),
): Server {
  const server = new Server(
    { name: "mixpanel", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (configuredRegions.length === 0) return { tools: [] };
    const byRegion = await Promise.all(configuredRegions.map(async (region) => ({
      region,
      tools: (await (await backendProvider(region)).client.listTools()).tools,
    })));
    armIdleTimer();
    const union = new Map<string, (typeof byRegion)[number]["tools"][number]>();
    for (const { tools } of byRegion) {
      for (const tool of tools) {
        if (READ_ONLY_TOOLS.has(tool.name) && !union.has(tool.name)) union.set(tool.name, tool);
      }
    }
    return {
      tools: [...union.values()].map((tool) => addRegionToSchema(tool, configuredRegions)),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!READ_ONLY_TOOLS.has(request.params.name)) {
      return mixpanelProxyError(`tool "${request.params.name}" is not available through the read-only proxy.`);
    }
    if (!runContext?.signed) {
      return mixpanelProxyError("Mixpanel MCP signed run context missing; refused to proxy request.");
    }
    const args = { ...(request.params.arguments ?? {}) };
    const region = args.region;
    delete args.region;
    if (typeof region !== "string" || !configuredRegions.includes(region as MixpanelRegion)) {
      return mixpanelProxyError(
        `region must be one of the configured regions: ${configuredRegions.join(", ") || "none"}.`,
      );
    }
    try {
      const { client } = await backendProvider(region as MixpanelRegion);
      armIdleTimer();
      return await client.callTool(
        { name: request.params.name, arguments: args },
        undefined,
        { timeout: MIXPANEL_PROXY_REQUEST_TIMEOUT_MS },
      ) as CallToolResult;
    } catch (err) {
      return mixpanelProxyError(
        `Mixpanel MCP proxy (${region}) error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return server;
}

export function configuredMixpanelRegions(): MixpanelRegion[] {
  const requested = (process.env.MIXPANEL_MCP_REGIONS ?? "us,eu,in")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  return (["us", "eu", "in"] as const).filter((region) => requested.includes(region));
}

export function mixpanelRegionUrl(region: MixpanelRegion): string {
  return REGION_URLS[region];
}

export async function closeMixpanelMcpBackends(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const active = [...backends.values()];
  backends.clear();
  await Promise.all(active.map(async (pending) => {
    const value = await pending.catch(() => null);
    await value?.client.close().catch(() => undefined);
    await value?.transport.close().catch(() => undefined);
  }));
}

function addRegionToSchema<T extends { inputSchema: Record<string, unknown> }>(
  tool: T,
  regions: MixpanelRegion[],
): T {
  const schema = tool.inputSchema;
  const properties = schema.properties && typeof schema.properties === "object"
    ? { ...(schema.properties as Record<string, unknown>) }
    : {};
  properties.region = {
    type: "string",
    enum: regions,
    description: "Mixpanel data-residency region for this request.",
  };
  const required = Array.isArray(schema.required) ? [...schema.required] : [];
  if (!required.includes("region")) required.unshift("region");
  return { ...tool, inputSchema: { ...schema, type: "object", properties, required } };
}

function getMixpanelBackend(region: MixpanelRegion): Promise<MixpanelBackend> {
  let current = backends.get(region);
  if (!current) {
    current = startMixpanelBackend(region).catch((err) => {
      backends.delete(region);
      throw err;
    });
    backends.set(region, current);
  }
  armIdleTimer();
  return current;
}

async function startMixpanelBackend(region: MixpanelRegion): Promise<MixpanelBackend> {
  const token = tokenForRegion(region);
  const transport = token
    ? new StreamableHTTPClientTransport(new URL(REGION_URLS[region]), {
      requestInit: { headers: { Authorization: authorizationHeader(token) } },
    })
    : new StreamableHTTPClientTransport(new URL(REGION_URLS[region]), {
      authProvider: await MixpanelOAuthProvider.create(region),
    });
  transport.onerror = (err) => log.warn("mixpanel-mcp", `${region} backend error: ${err.message}`);
  transport.onclose = () => {
    backends.delete(region);
    log.info("mixpanel-mcp", `${region} backend closed`);
  };
  const client = new Client(
    { name: `junior-mixpanel-${region}-proxy`, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  log.info("mixpanel-mcp", `${region} backend started`);
  return { client, transport };
}

function tokenForRegion(region: MixpanelRegion): string {
  const regional = process.env[`MIXPANEL_MCP_${region.toUpperCase()}_TOKEN`]?.trim();
  if (regional) return regional;
  return region === "us" ? process.env.MIXPANEL_MCP_TOKEN?.trim() ?? "" : "";
}

function authorizationHeader(token: string): string {
  return /^Bearer\s+/i.test(token) ? token : `Bearer Basic ${token}`;
}

function mixpanelProxyError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeMixpanelMcpBackends().catch((err) => {
      log.warn("mixpanel-mcp", `idle close failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, MIXPANEL_PROXY_IDLE_TTL_MS);
  idleTimer.unref?.();
}
