import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SlackMcpRunContext } from "./context.ts";
import {
  configuredMongoConnections,
  createMongoProxyServer,
} from "./mongodb-proxy.ts";

const RUN_CONTEXT: SlackMcpRunContext = {
  agent: "thinker",
  channel: "C01",
  threadId: "thread-1",
  signed: true,
};

const originalConnections = process.env.MDB_MCP_CONNECTIONS;
afterEach(() => {
  if (originalConnections === undefined) delete process.env.MDB_MCP_CONNECTIONS;
  else process.env.MDB_MCP_CONNECTIONS = originalConnections;
});

describe("MongoDB MCP read-only proxy", () => {
  it("mirrors backend schemas and forwards nested filter arguments", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const backendClient = {
      async listTools() {
        return {
          tools: [
            {
              name: "find",
              description: "Run a find query against a MongoDB collection",
              inputSchema: {
                type: "object" as const,
                properties: {
                  connectionId: { type: "string" },
                  database: { type: "string" },
                  collection: { type: "string" },
                  filter: {
                    type: "object",
                    additionalProperties: true,
                  },
                  limit: {
                    type: "number",
                    minimum: 0,
                    maximum: 1000,
                    description: "Upstream page size",
                    "x-upstream": "preserved",
                  },
                },
                required: ["connectionId", "database", "collection"],
              },
            },
            {
              name: "insert-many",
              inputSchema: { type: "object" as const },
            },
          ],
        };
      },
      async callTool(request: { name: string; arguments?: Record<string, unknown> }) {
        calls.push(request);
        return {
          content: [{ type: "text" as const, text: "ok" }],
        };
      },
    };
    const server = createMongoProxyServer(
      RUN_CONTEXT,
      async () => ({ client: backendClient as never }),
      ["preconfigured"],
    );
    const client = new Client({ name: "mongo-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["find"]);
      expect(tools[0]?.inputSchema).toMatchObject({
        properties: {
          connection: { type: "string", enum: ["preconfigured"] },
          database: { type: "string" },
          filter: {
            type: "object",
            additionalProperties: true,
          },
        },
      });
      expect(tools[0]?.inputSchema.properties).not.toHaveProperty("connectionId");
      expect(tools[0]?.inputSchema.properties?.limit).toEqual({
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Upstream page size. Must be between 1 and 100.",
        "x-upstream": "preserved",
      });
      expect(tools[0]?.inputSchema.required).toEqual(["connection", "database", "collection", "limit"]);

      const filter = {
        status: { $in: ["active", "trial"] },
        createdAt: { $gte: { $date: "2026-07-01T00:00:00.000Z" } },
      };
      const result = await client.callTool({
        name: "find",
        arguments: {
          connection: "preconfigured",
          database: "app",
          collection: "members",
          filter,
          limit: 50,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(calls).toEqual([{
        name: "find",
        arguments: {
          connectionId: "preconfigured",
          database: "app",
          collection: "members",
          filter,
          limit: 50,
        },
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects unbounded and over-cap finds before touching the backend", async () => {
    let called = false;
    const server = createMongoProxyServer(RUN_CONTEXT, async () => ({
      client: {
        async listTools() { return { tools: [] }; },
        async callTool() { called = true; return { content: [{ type: "text" as const, text: "unexpected" }] }; },
      } as never,
    }), ["preconfigured"]);
    const client = new Client({ name: "mongo-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const limit of [undefined, 101, 0]) {
        const result = await client.callTool({
          name: "find",
          arguments: {
            connection: "preconfigured",
            database: "app",
            collection: "members",
            ...(limit === undefined ? {} : { limit }),
          },
        });
        expect(result.isError).toBe(true);
      }
      expect(called).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires a signed run context before any bounded find", async () => {
    let called = false;
    const server = createMongoProxyServer(null, async () => ({
      client: {
        async listTools() { return { tools: [] }; },
        async callTool() { called = true; return { content: [{ type: "text" as const, text: "unexpected" }] }; },
      } as never,
    }), ["preconfigured"]);
    const client = new Client({ name: "mongo-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "find",
        arguments: { database: "app", collection: "members", limit: 10 },
      });
      expect(result.isError).toBe(true);
      expect(called).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("overrides guessed connection IDs with the configured connection", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const server = createMongoProxyServer(RUN_CONTEXT, async () => ({
      client: {
        async listTools() {
          return { tools: [] };
        },
        async callTool(request: { name: string; arguments?: Record<string, unknown> }) {
          calls.push(request);
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      } as never,
    }), ["preconfigured"]);
    const client = new Client({ name: "mongo-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      await client.callTool({
        name: "list-databases",
        arguments: { connection: "preconfigured", connectionId: "growthx-prod" },
      });
      expect(calls).toEqual([{
        name: "list-databases",
        arguments: { connectionId: "preconfigured" },
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not expose or call write tools returned by the backend", async () => {
    let called = false;
    const backendClient = {
      async listTools() {
        return {
          tools: [{
            name: "delete-many",
            inputSchema: { type: "object" as const },
          }],
        };
      },
      async callTool() {
        called = true;
        return { content: [{ type: "text" as const, text: "unexpected" }] };
      },
    };
    const server = createMongoProxyServer(
      RUN_CONTEXT,
      async () => ({ client: backendClient as never }),
      ["preconfigured"],
    );
    const client = new Client({ name: "mongo-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect((await client.listTools()).tools).toEqual([]);
      const result = await client.callTool({
        name: "delete-many",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(called).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes calls through the selected named connection", async () => {
    const calls: Array<{ connectionId: string; request: unknown }> = [];
    const server = createMongoProxyServer(
      RUN_CONTEXT,
      async (connectionId) => ({
        client: {
          async listTools() {
            return {
              tools: [{
                name: "list-databases",
                inputSchema: { type: "object" as const },
              }],
            };
          },
          async callTool(request: unknown) {
            calls.push({ connectionId, request });
            return { content: [{ type: "text" as const, text: connectionId }] };
          },
        } as never,
      }),
      ["dev", "prod"],
    );
    const client = new Client({ name: "mongo-proxy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      expect(tools[0]?.inputSchema).toMatchObject({
        properties: { connection: { type: "string", enum: ["dev", "prod"] } },
        required: ["connection"],
      });
      const result = await client.callTool({
        name: "list-databases",
        arguments: { connection: "dev" },
      });
      expect(result.isError).not.toBe(true);
      expect(calls).toEqual([{
        connectionId: "dev",
        request: {
          name: "list-databases",
          arguments: { connectionId: "preconfigured" },
        },
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("parses named connection URIs without exposing them", () => {
    process.env.MDB_MCP_CONNECTIONS = JSON.stringify({
      prod: "mongodb://prod.example/test",
      dev: "mongodb://dev.example/GX-debug",
    });
    expect(configuredMongoConnections()).toEqual([
      { id: "dev", connectionString: "mongodb://dev.example/GX-debug" },
      { id: "prod", connectionString: "mongodb://prod.example/test" },
    ]);
  });
});
