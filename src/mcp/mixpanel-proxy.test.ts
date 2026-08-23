import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SlackMcpRunContext } from "./context.ts";
import { createMixpanelProxyServer, type MixpanelRegion } from "./mixpanel-proxy.ts";
import { MixpanelOAuthProvider } from "./mixpanel-oauth.ts";

let oauthTestDir: string | null = null;
afterEach(async () => {
  delete process.env.MIXPANEL_MCP_OAUTH_DIR;
  if (oauthTestDir) await rm(oauthTestDir, { recursive: true, force: true });
  oauthTestDir = null;
});

const RUN_CONTEXT: SlackMcpRunContext = {
  agent: "feature-metrics",
  channel: "C01",
  threadId: "thread-1",
  signed: true,
};

describe("Mixpanel multi-region read-only proxy", () => {
  it("persists independent OAuth clients and tokens with restricted permissions", async () => {
    oauthTestDir = await mkdtemp(join(tmpdir(), "junior-mixpanel-oauth-"));
    process.env.MIXPANEL_MCP_OAUTH_DIR = oauthTestDir;
    const us = await MixpanelOAuthProvider.create("us");
    await us.saveClientInformation({ client_id: "us-client" });
    await us.saveTokens({ access_token: "us-access", token_type: "bearer", refresh_token: "us-refresh" });
    const eu = await MixpanelOAuthProvider.create("eu");
    await eu.saveTokens({ access_token: "eu-access", token_type: "bearer", refresh_token: "eu-refresh" });

    expect((await MixpanelOAuthProvider.create("us")).tokens()?.refresh_token).toBe("us-refresh");
    expect((await MixpanelOAuthProvider.create("eu")).tokens()?.refresh_token).toBe("eu-refresh");
    expect((await stat(join(oauthTestDir, "us.json"))).mode & 0o777).toBe(0o600);
  });

  it("combines region tools and routes calls using a required region argument", async () => {
    const calls: Array<{ region: MixpanelRegion; request: unknown }> = [];
    const provider = async (region: MixpanelRegion) => ({
      client: {
        async listTools() {
          return { tools: [{
            name: "Run-Query",
            description: "Run an analysis",
            inputSchema: {
              type: "object" as const,
              properties: { project_id: { type: "string" } },
              required: ["project_id"],
            },
          }] };
        },
        async callTool(request: unknown) {
          calls.push({ region, request });
          return { content: [{ type: "text" as const, text: region }] };
        },
        async close() {},
      } as never,
    });
    const server = createMixpanelProxyServer(RUN_CONTEXT, provider, ["us", "eu"]);
    const client = new Client({ name: "mixpanel-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);
      expect(tools.tools[0]?.inputSchema).toMatchObject({
        properties: { region: { type: "string", enum: ["us", "eu"] } },
        required: ["region", "project_id"],
      });
      const result = await client.callTool({
        name: "Run-Query",
        arguments: { region: "eu", project_id: "123" },
      });
      expect(result.isError).not.toBe(true);
      expect(calls).toEqual([{ region: "eu", request: {
        name: "Run-Query",
        arguments: { project_id: "123" },
      } }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects unconfigured regions and write tools", async () => {
    let called = false;
    const server = createMixpanelProxyServer(RUN_CONTEXT, async () => ({
      client: {
        async listTools() { return { tools: [] }; },
        async callTool() {
          called = true;
          return { content: [{ type: "text" as const, text: "unexpected" }] };
        },
        async close() {},
      } as never,
    }), ["us"]);
    const client = new Client({ name: "mixpanel-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect((await client.callTool({
        name: "Run-Query",
        arguments: { region: "eu" },
      })).isError).toBe(true);
      expect((await client.callTool({
        name: "Create-Dashboard",
        arguments: { region: "us" },
      })).isError).toBe(true);
      expect(called).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires authenticated run context before forwarding calls", async () => {
    let called = false;
    const server = createMixpanelProxyServer(null, async () => ({
      client: {
        async listTools() { return { tools: [] }; },
        async callTool() {
          called = true;
          return { content: [{ type: "text" as const, text: "unexpected" }] };
        },
        async close() {},
      } as never,
    }), ["us"]);
    const client = new Client({ name: "mixpanel-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect((await client.callTool({
        name: "Run-Query",
        arguments: { region: "us" },
      })).isError).toBe(true);
      expect(called).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
