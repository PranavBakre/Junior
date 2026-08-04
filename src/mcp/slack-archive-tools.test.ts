import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SlackArchiveStore } from "../slack/archive-store.ts";
import {
  registerSlackArchiveTools,
  setSlackArchiveStore,
  type SlackArchiveToolAuth,
} from "./slack-archive-tools.ts";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
}>;

function captureTools(): { tools: Map<string, ToolHandler>; server: McpServer } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { tools, server };
}

const SIGNED_PUBLIC_CHANNEL: SlackArchiveToolAuth = {
  runContext: {
    agent: "default",
    channel: "C_FORGEABLE",
    threadId: "1700000000.000001",
    signed: true,
  },
  isAllowedChannel: async (channelId) => channelId === "C_PUBLIC",
  getSession: async () => ({ channel: "C_PUBLIC" }),
};

function seed(store: SlackArchiveStore): void {
  store.upsertMessage({
    channelId: "C_ENG",
    channelName: "engineering",
    ts: "1700000000.000001",
    threadTs: "1700000000.000001",
    actorId: "U_ALICE",
    userId: "U_ALICE",
    actorName: "Alice",
    actorKind: "human",
    text: "deploy payments safely",
    ingestSource: "backfill",
  });
  store.upsertMessage({
    channelId: "C_ENG",
    channelName: "engineering",
    ts: "1700000001.000001",
    threadTs: "1700000000.000001",
    actorId: "U_BOB",
    userId: "U_BOB",
    actorName: "Bob",
    actorKind: "human",
    text: "payments deploy complete",
    ingestSource: "live",
  });
  store.upsertMessage({
    channelId: "C_SALES",
    channelName: "sales",
    ts: "1700000100.000001",
    actorId: "U_ALICE",
    userId: "U_ALICE",
    actorName: "Alice",
    actorKind: "human",
    text: "deploy sales dashboard",
    ingestSource: "backfill",
  });
}

describe("Slack archive MCP tools", () => {
  let store: SlackArchiveStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    store = new SlackArchiveStore(":memory:");
    seed(store);
    setSlackArchiveStore(store);
    const captured = captureTools();
    tools = captured.tools;
    registerSlackArchiveTools(captured.server, SIGNED_PUBLIC_CHANNEL);
  });

  afterEach(() => {
    setSlackArchiveStore(null);
    store.close();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const handler = tools.get(name);
    if (!handler) throw new Error(`tool not registered: ${name}`);
    return (await handler(args)).content[0]!.text;
  }

  test("registers only the two read tools", () => {
    expect([...tools.keys()].sort()).toEqual(["slack_archive_search", "slack_archive_thread"]);
  });

  test("search applies channel, actor, and time filters and includes source coordinates", async () => {
    const output = await call("slack_archive_search", {
      query: "deploy",
      channel: "C_ENG",
      actor: "U_ALICE",
      since_ms: 1_699_999_999_000,
      until_ms: 1_700_000_000_500,
    });
    expect(output).toContain("deploy payments safely");
    expect(output).not.toContain("sales dashboard");
    expect(output).toContain("source=slack_archive channel=C_ENG");
    expect(output).toContain("thread_ts=1700000000.000001");
    expect(output).toContain("ts=1700000000.000001");
  });

  test("search can expand a hit with chronological thread context", async () => {
    const output = await call("slack_archive_search", {
      query: "safely",
      expand_threads: true,
    });
    expect(output.indexOf("deploy payments safely")).toBeLessThan(output.indexOf("payments deploy complete"));
    expect(output).toContain("expanded_thread=true");
  });

  test("thread reads exact channel and thread_ts in chronological order", async () => {
    const output = await call("slack_archive_thread", {
      channel: "C_ENG",
      thread_ts: "1700000000.000001",
    });
    expect(output.indexOf("deploy payments safely")).toBeLessThan(output.indexOf("payments deploy complete"));
    expect(output).not.toContain("sales dashboard");
  });

  test("archived bodies and channel/user names are enclosed in an untrusted boundary", async () => {
    const output = await call("slack_archive_search", { query: "deploy" });
    expect(output).toContain("BEGIN UNTRUSTED SLACK ARCHIVE");
    expect(output).toContain('name="engineering"');
    expect(output).toContain('name="Alice"');
    expect(output).toContain("END UNTRUSTED SLACK ARCHIVE");
  });

  test("per-message and aggregate response sizes are bounded", async () => {
    for (let i = 0; i < 100; i++) {
      store.upsertMessage({
        channelId: "C_BIG",
        channelName: "large",
        ts: `170001${String(i).padStart(4, "0")}.000001`,
        actorId: "U_BIG",
        actorName: "Large User",
        actorKind: "human",
        text: `needle ${i} ${"x".repeat(5_000)}`,
      });
    }
    const output = await call("slack_archive_search", { query: "needle", limit: 100 });
    expect(output).toContain("[…truncated]");
    expect(output).toContain("omitted to bound response size");
    expect(output.length).toBeLessThanOrEqual(60_000);
  });

  test("returns not enabled before archive bootstrap provides the store", async () => {
    setSlackArchiveStore(null);
    expect(await call("slack_archive_search", { query: "deploy" })).toContain("not enabled");
  });
});

describe("Slack archive MCP authorization", () => {
  let store: SlackArchiveStore;

  beforeEach(() => {
    store = new SlackArchiveStore(":memory:");
    seed(store);
    setSlackArchiveStore(store);
  });

  afterEach(() => {
    setSlackArchiveStore(null);
    store.close();
  });

  async function searchWith(auth: SlackArchiveToolAuth): Promise<string> {
    const captured = captureTools();
    registerSlackArchiveTools(captured.server, auth);
    return (await captured.tools.get("slack_archive_search")!({ query: "deploy" })).content[0]!.text;
  }

  test("allows a signed turn whose stored channel is public or approved", async () => {
    expect(await searchWith(SIGNED_PUBLIC_CHANNEL)).not.toContain("denied");
    expect(await searchWith({
      ...SIGNED_PUBLIC_CHANNEL,
      getSession: async () => ({ channel: "G_APPROVED" }),
      isAllowedChannel: async (channelId) => channelId === "G_APPROVED",
    })).not.toContain("denied");
  });

  test("denies bare and unsigned contexts", async () => {
    expect(await searchWith({ ...SIGNED_PUBLIC_CHANNEL, runContext: null })).toContain("denied");
    expect(await searchWith({
      ...SIGNED_PUBLIC_CHANNEL,
      runContext: { ...SIGNED_PUBLIC_CHANNEL.runContext!, signed: false },
    })).toContain("denied");
  });

  test("uses the stored live session channel, not the claimed context channel", async () => {
    expect(await searchWith({
      ...SIGNED_PUBLIC_CHANNEL,
      runContext: { ...SIGNED_PUBLIC_CHANNEL.runContext!, channel: "C_PUBLIC" },
      getSession: async () => ({ channel: "G_DENIED" }),
      isAllowedChannel: async (channelId) => channelId === "C_PUBLIC",
    })).toContain("denied");
  });

  test("denies unknown sessions and stored channels outside the policy", async () => {
    expect(await searchWith({ ...SIGNED_PUBLIC_CHANNEL, getSession: async () => null })).toContain("denied");
    expect(await searchWith({
      ...SIGNED_PUBLIC_CHANNEL,
      getSession: async () => ({ channel: "G_PRIVATE" }),
      isAllowedChannel: async () => false,
    })).toContain("denied");
  });
});
