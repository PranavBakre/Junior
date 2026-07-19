import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWhatsAppTools, setWhatsAppHandle } from "./whatsapp-tools.ts";
import { WhatsAppStore } from "../whatsapp/store.ts";
import type { WhatsAppHandle } from "../whatsapp/index.ts";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
}>;

/** Capture registered tools off a fake McpServer so handlers run directly. */
function captureTools(): { tools: Map<string, ToolHandler>; server: McpServer } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { tools, server };
}

function seedStore(store: WhatsAppStore): void {
  const base = {
    senderJid: "999@s.whatsapp.net",
    senderName: "Alice",
    replyToId: null,
    raw: null,
  };
  store.upsertMessage({
    ...base,
    id: "a",
    groupJid: "g1@g.us",
    groupName: "Hermes Buildathon",
    ts: 100,
    text: "kickoff at 10am",
  });
  store.upsertMessage({
    ...base,
    id: "b",
    groupJid: "g1@g.us",
    groupName: "Hermes Buildathon",
    ts: 200,
    text: "deploy is done",
  });
  store.upsertMessage({
    ...base,
    id: "c",
    groupJid: "g2@g.us",
    groupName: "Hermes Mentors",
    ts: 300,
    text: "mentor hours moved",
  });
}

describe("whatsapp MCP tools", () => {
  let store: WhatsAppStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    store = new WhatsAppStore(":memory:");
    seedStore(store);
    const handle: WhatsAppHandle = {
      store,
      resolveGroupName: () => undefined,
      stop: async () => {},
    };
    setWhatsAppHandle(handle);
    const captured = captureTools();
    tools = captured.tools;
    registerWhatsAppTools(captured.server);
  });

  afterEach(() => {
    setWhatsAppHandle(null);
    store.close();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const handler = tools.get(name);
    if (!handler) throw new Error(`tool not registered: ${name}`);
    const result = await handler(args);
    return result.content[0]!.text;
  }

  test("registers the three read/search tools", () => {
    expect([...tools.keys()].sort()).toEqual([
      "whatsapp_list_groups",
      "whatsapp_read_messages",
      "whatsapp_search_messages",
    ]);
  });

  test("all tools answer 'not enabled' when no handle is set", async () => {
    setWhatsAppHandle(null);
    for (const name of tools.keys()) {
      const text = await call(name, { query: "x" });
      expect(text).toContain("not enabled");
    }
  });

  test("whatsapp_list_groups summarises groups newest-activity first", async () => {
    const text = await call("whatsapp_list_groups");
    const lines = text.split("\n");
    expect(lines[0]).toContain("Hermes Mentors");
    expect(lines[0]).toContain("g2@g.us");
    expect(lines[1]).toContain("Hermes Buildathon");
    expect(lines[1]).toContain("2 messages");
    // First AND last activity, as the tool description promises.
    expect(lines[1]).toContain("1970-01-01 → 1970-01-01");
  });

  test("whatsapp_read_messages resolves a group by subject substring", async () => {
    const text = await call("whatsapp_read_messages", { group: "buildathon" });
    expect(text).toContain("kickoff at 10am");
    expect(text).toContain("deploy is done");
    expect(text).not.toContain("mentor hours moved");
    // Paging footer carries the tie-safe (ts, id) cursor of the earliest message.
    expect(text).toContain("before_ts=100");
    expect(text).toContain("before_id=a");
  });

  test("whatsapp_read_messages reports ambiguous group references", async () => {
    const text = await call("whatsapp_read_messages", { group: "hermes" });
    expect(text).toContain("matches 2 groups");
    expect(text).toContain("g1@g.us");
    expect(text).toContain("g2@g.us");
  });

  test("whatsapp_read_messages accepts an exact JID", async () => {
    const text = await call("whatsapp_read_messages", { group: "g2@g.us" });
    expect(text).toContain("mentor hours moved");
    expect(text).not.toContain("kickoff");
  });

  test("whatsapp_read_messages reports unknown groups", async () => {
    const text = await call("whatsapp_read_messages", { group: "nope" });
    expect(text).toContain("No stored group matches");
  });

  test("whatsapp_search_messages finds text across groups with group labels", async () => {
    const text = await call("whatsapp_search_messages", { query: "mentor" });
    expect(text).toContain("mentor hours moved");
    expect(text).toContain("[Hermes Mentors]");
  });

  test("whatsapp_search_messages reports empty results", async () => {
    const text = await call("whatsapp_search_messages", { query: "zzz" });
    expect(text).toBe("No messages matched.");
  });

  test("long message bodies are truncated per message", async () => {
    store.upsertMessage({
      id: "long",
      groupJid: "g1@g.us",
      groupName: "Hermes Buildathon",
      senderJid: "999@s.whatsapp.net",
      senderName: "Alice",
      ts: 400,
      text: `start-marker ${"x".repeat(5000)}`,
      replyToId: null,
      raw: null,
    });
    const text = await call("whatsapp_read_messages", { group: "g1@g.us" });
    expect(text).toContain("start-marker");
    expect(text).toContain("[…truncated]");
    expect(text.length).toBeLessThan(4000);
  });

  test("aggregate output is capped, dropping the oldest transcript lines", async () => {
    for (let i = 0; i < 100; i++) {
      store.upsertMessage({
        id: `bulk-${String(i).padStart(3, "0")}`,
        groupJid: "g1@g.us",
        groupName: "Hermes Buildathon",
        senderJid: "999@s.whatsapp.net",
        senderName: "Alice",
        ts: 1000 + i,
        text: `bulk message ${i} ${"y".repeat(1400)}`,
        replyToId: null,
        raw: null,
      });
    }
    const text = await call("whatsapp_read_messages", { group: "g1@g.us", limit: 100 });
    expect(text.length).toBeLessThan(70_000);
    expect(text).toContain("omitted to bound response size");
    // The newest message survives; the oldest bulk line is what got dropped.
    expect(text).toContain("bulk message 99");
    expect(text).not.toContain("bulk message 0 ");
  });
});
