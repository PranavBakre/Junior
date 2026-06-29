import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMemory,
  dispatchAgentDirectivesFromSlackPost,
  recallMemory,
  searchAgentDefinitions,
  sendSlackDirectMessage,
  type MemoryToolDeps,
} from "./slack-server.ts";
import { createMemoryStore } from "../memory/factory.ts";
import { HashingEmbeddingProvider } from "../memory/embedding/hashing.ts";
import { createProfileStore } from "../memory/profiles/index.ts";

/**
 * Build memory-tool deps backed by REAL infrastructure (in-memory SQLite store,
 * the deterministic hashing embedding provider, a temp-dir profile store) so the
 * tests exercise the actual store/embed/profile code paths and only the model
 * download is avoided. Mock at the boundary, not the internals (CLAUDE.md r15).
 */
function makeMemoryDeps(): { deps: MemoryToolDeps; cleanup: () => void } {
  const store = createMemoryStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "junior-profiles-"));
  const deps: MemoryToolDeps = {
    store,
    provider: new HashingEmbeddingProvider(),
    profileStore: createProfileStore({ root }),
  };
  return {
    deps,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("MCP memory v3 tools", () => {
  it("memory_add embeds and persists a retrievable claim", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      const { id } = await addMemory(
        {
          text: "Always create worktrees from origin/main, never the local checkout",
          kind: "lesson",
          repo: "gx-backend",
          tags: ["worktree"],
        },
        deps,
      );
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");

      // Persisted with its embedding co-located → reachable via the store's own
      // semantic recall (proves the embedding was written, not just the text).
      const provider = deps.provider;
      const [queryVector] = await provider.embed(["worktree from main"], "query");
      const claims = await deps.store.recallClaims({
        queryVector,
        limit: 5,
      });
      expect(claims.some((c) => c.id === id)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("memory_recall returns the added claim for a related query", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      const { id } = await addMemory(
        { text: "Resolve merge conflicts in the target branch, not the feature branch" },
        deps,
      );

      const result = await recallMemory(
        { query: "where do I resolve merge conflicts target branch", limit: 5 },
        deps,
      );

      expect(result.claims.some((c) => c.id === id)).toBe(true);
      expect(result.profiles).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("memory_recall includes a keyed profile when entityRefs is passed", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      await deps.profileStore.upsertProfile({
        kind: "person",
        entity_ref: "pranav:person",
        role: "principal / architect",
        comms_style: "terse, pushes back hard",
        body: "Pranav is the principal.",
      });

      await addMemory({ text: "Junior posts only on a closed allow-list in bug threads" }, deps);

      const result = await recallMemory(
        {
          query: "how should Junior behave in threads",
          entityRefs: ["pranav:person"],
          limit: 5,
        },
        deps,
      );

      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0]).toMatchObject({
        entity_ref: "pranav:person",
        kind: "person",
        role: "principal / architect",
      });
    } finally {
      cleanup();
    }
  });

  it("memory_recall tolerates a malformed entity_ref without failing", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      const result = await recallMemory(
        { query: "anything", entityRefs: ["not-a-valid-ref"], limit: 3 },
        deps,
      );
      expect(result.profiles).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("MCP agent search", () => {
  it("finds public agent definitions", async () => {
    const agents = await searchAgentDefinitions({
      query: "default",
      includePublic: true,
      includePrivate: false,
      limit: 10,
    });

    expect(agents.some((agent) => agent.name === "default")).toBe(true);
    expect(agents.every((agent) => agent.origin === "public")).toBe(true);
  });

  it("finds private overlay agent definitions", async () => {
    const agents = await searchAgentDefinitions({
      query: "db-executioner",
      includePublic: false,
      includePrivate: true,
      limit: 10,
    });

    expect(agents).toContainEqual(
      expect.objectContaining({
        name: "db-executioner",
        origin: "private",
        path: "agents-org/db-executioner.md",
      }),
    );
  });
});

describe("MCP Slack DM helper", () => {
  it("opens a DM channel before posting to a user", async () => {
    const calls: unknown[] = [];
    const client = {
      conversations: {
        open: async (args: unknown) => {
          calls.push(["open", args]);
          return { channel: { id: "D123" } };
        },
      },
      chat: {
        postMessage: async (args: unknown) => {
          calls.push(["postMessage", args]);
          return { ts: "123.456" };
        },
      },
    };

    await expect(
      sendSlackDirectMessage(client, {
        userId: "U123",
        text: "secret",
        username: "Onboarding Guide",
        iconEmoji: ":compass:",
      }),
    ).resolves.toEqual({ channelId: "D123", ts: "123.456" });

    expect(calls).toEqual([
      ["open", { users: "U123", return_im: true }],
      [
        "postMessage",
        {
          channel: "D123",
          text: "secret",
          username: "Onboarding Guide",
          icon_emoji: ":compass:",
        },
      ],
    ]);
  });
});

describe("MCP Slack agent directive interception", () => {
  it("ignores normal Slack post text", async () => {
    await expect(
      dispatchAgentDirectivesFromSlackPost({
        text: "normal update",
        channelId: "C123",
        threadTs: "111.222",
        runContext: { agent: "default", channel: "C123", threadId: "111.222" },
        manager: { handleAgentMessage: async () => undefined },
      }),
    ).resolves.toBeNull();
  });

  it("dispatches pure persistent-agent directives instead of posting them", async () => {
    const calls: unknown[] = [];

    const result = await dispatchAgentDirectivesFromSlackPost({
      text: "!review review https://github.com/GrowthX-Club/gx-backend/pull/3199 again",
      channelId: "C123",
      threadTs: "111.222",
      runContext: { agent: "default", channel: "C123", threadId: "111.222" },
      manager: {
        handleAgentMessage: async (event, agentName) => {
          calls.push({ event, agentName });
        },
      },
    });

    expect(JSON.parse(result ?? "{}")).toMatchObject({
      ok: true,
      dispatched: ["review"],
      thread: "111.222",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agentName: "review",
      event: {
        threadId: "111.222",
        channel: "C123",
        text: "review https://github.com/GrowthX-Club/gx-backend/pull/3199 again",
        isSelfBot: true,
        botUsername: "Junior",
      },
    });
  });
});
