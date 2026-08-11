import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SlackMcpRunContext } from "./context.ts";
import { createMongoProxyServer } from "./mongodb-proxy.ts";

const RUN_CONTEXT: SlackMcpRunContext = {
  agent: "thinker",
  channel: "C01",
  threadId: "thread-1",
  signed: true,
};

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
          database: { type: "string" },
          filter: {
            type: "object",
            additionalProperties: true,
          },
        },
      });

      const filter = {
        status: { $in: ["active", "trial"] },
        createdAt: { $gte: { $date: "2026-07-01T00:00:00.000Z" } },
      };
      const result = await client.callTool({
        name: "find",
        arguments: {
          connectionId: "preconfigured",
          database: "app",
          collection: "members",
          filter,
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
        },
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
});
