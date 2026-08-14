import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMemory,
  dispatchAgentDirectivesFromSlackPost,
  recallMemory,
  registerTools,
  searchAgentDefinitions,
  sendSlackDirectMessage,
  type MemoryToolDeps,
} from "./slack-server.ts";
import { createMemoryStore } from "../memory/factory.ts";
import { HashingEmbeddingProvider } from "../memory/embedding/hashing.ts";
import { createProfileStore } from "../memory/profiles/index.ts";

describe("MCP Slack tool catalogue", () => {
  it("serializes every registered tool through tools/list", async () => {
    const server = new McpServer({ name: "slack-bot-test", version: "0.1.0" });
    registerTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "slack-bot-test-client", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain("pipeline_report_outcome");
      expect(names).toContain("runbook_select");
      expect(names).toContain("promotion_record");
      const memoryRecall = tools.find((tool) => tool.name === "memory_recall");
      expect(memoryRecall?.inputSchema).toMatchObject({
        properties: {
          fact_kinds: { type: "array" },
        },
      });
      const dispatch = tools.find((tool) => tool.name === "agent_dispatch");
      expect(dispatch?.inputSchema).toMatchObject({
        properties: {
          repo_refs: { type: "array" },
        },
      });
      const skillDispatch = tools.find((tool) => tool.name === "skill_dispatch");
      expect(skillDispatch?.inputSchema).toMatchObject({
        required: expect.arrayContaining([
          "skill_name",
          "objective",
          "reason",
          "idempotency_key",
        ]),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

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

  it("memory_add merges a reworded claim instead of storing a near-duplicate", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      // memory_add derives its id from the text, so a one-word edit used to
      // produce a different id and a brand-new row: exact-match dedup, not
      // semantic. The store's write guard is what closes that.
      const first = await addMemory(
        {
          text: "`command <tool>` is the escape hatch when a wrapper alias or hook is rewriting your invocation",
          kind: "lesson",
        },
        deps,
      );
      expect(first.action).toBe("inserted");

      const second = await addMemory(
        {
          text: "`command <tool>` is the escape hatch when a wrapper alias or hook is silently rewriting your invocation",
          kind: "lesson",
        },
        deps,
      );

      expect(second.action).toBe("merged");
      expect(second.mergedInto).toBe(first.id);
      // One row, not two: recall gets one distinct idea back, not a paraphrase pair.
      expect(await deps.store.exportClaimVectors()).toHaveLength(1);
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
        {
          query: "where do I resolve merge conflicts target branch",
          limit: 5,
          minCosine: 0,
        },
        deps,
      );

      expect(result.claims.some((c) => c.id === id)).toBe(true);
      expect(result.profiles).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("memory_recall expands an atomic claim to its source section", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      const written = await addMemory(
        {
          text: "Use the deployment secret store for the release credential",
          sourcePath: "memory/deployment.md",
          sourceHeading: "Production publishing",
          sourceText: "Before publishing, export SITE_RELEASE_KEY from the deployment secret store.",
        },
        deps,
      );
      const result = await recallMemory(
        { query: "Where is SITE_RELEASE_KEY configured?", limit: 5 },
        deps,
      );

      expect(result.claims).toContainEqual(
        expect.objectContaining({
          id: written.id,
          contextText: expect.stringContaining("export SITE_RELEASE_KEY"),
          sourcePath: "memory/deployment.md",
          sourceHeading: "Production publishing",
        }),
      );
    } finally {
      cleanup();
    }
  });

  it("memory_recall preserves legacy OR tag filtering", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      const relevant = await addMemory(
        {
          text: "Reuse the event registration pricing helper for summary-card tooltips",
          tags: ["gx-client-next", "event-registration"],
        },
        deps,
      );
      await addMemory(
        {
          text: "Event payout invoices join through payment identifiers",
          tags: ["payouts", "mongodb"],
        },
        deps,
      );

      const result = await recallMemory(
        {
          query:
            "price breakdown tooltip event registration summary card pricing helper",
          tags: ["gx-client-next", "event-registration", "pricing"],
          limit: 5,
        },
        deps,
      );

      expect(result.claims.map((claim) => claim.id)).toEqual([relevant.id]);
    } finally {
      cleanup();
    }
  });

  it("memory_recall filters and identifies procedure fact subtypes", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      const procedureId = "procedure-clean-merged-worktrees";
      const procedureText =
        "Clean merged worktrees only after verifying the pull request is merged";
      const [embedding] = await deps.provider.embed([procedureText], "document");
      await deps.store.upsertFact({
        id: procedureId,
        kind: "procedure",
        body: procedureText,
        createdAt: Date.now(),
      });
      await deps.store.upsertClaim({
        id: procedureId,
        kind: "fact",
        text: procedureText,
        embedding,
        embedModel: deps.provider.model,
        dim: deps.provider.dim,
        tags: ["procedure", "worktree"],
        createdAt: Date.now(),
        skipDedup: true,
      });
      await addMemory(
        {
          text: "Worktree cards display their branch names",
          kind: "fact",
        },
        deps,
      );

      const result = await recallMemory(
        {
          query: "how to clean merged worktrees",
          factKinds: ["procedure"],
          limit: 5,
          minCosine: 0,
        },
        deps,
      );

      expect(result.claims).toEqual([
        expect.objectContaining({
          id: procedureId,
          kind: "fact",
          factKind: "procedure",
        }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("unions non-fact kinds with requested fact subtypes", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      const lesson = await addMemory(
        {
          text: "Never run a repository-wide worktree prune while preserving a dev-server slot",
          kind: "lesson",
        },
        deps,
      );
      const procedureId = "procedure-prune-empty-worktrees";
      const procedureText =
        "Remove an empty worktree only after checking commits and real local edits";
      const [procedureEmbedding] = await deps.provider.embed(
        [procedureText],
        "document",
      );
      await deps.store.upsertFact({
        id: procedureId,
        kind: "procedure",
        body: procedureText,
        createdAt: Date.now(),
      });
      await deps.store.upsertClaim({
        id: procedureId,
        kind: "fact",
        text: procedureText,
        embedding: procedureEmbedding,
        embedModel: deps.provider.model,
        dim: deps.provider.dim,
        createdAt: Date.now(),
        skipDedup: true,
      });
      const ordinaryFact = await addMemory(
        {
          text: "The dashboard displays the current worktree branch name",
          kind: "fact",
        },
        deps,
      );

      const result = await recallMemory(
        {
          query: "safely prune empty worktrees without harming dev-server slots",
          kinds: ["lesson", "fact"],
          factKinds: ["procedure"],
          limit: 5,
          minCosine: -1,
        },
        deps,
      );

      expect(result.claims.map((claim) => claim.id)).toEqual(
        expect.arrayContaining([lesson.id, procedureId]),
      );
      expect(result.claims.map((claim) => claim.id)).not.toContain(ordinaryFact.id);
      expect(result.claims.find((claim) => claim.id === procedureId)?.factKind).toBe(
        "procedure",
      );
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

  it("drops low-relevance filler and logs only the final returned ids", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      const relevant = await addMemory(
        { text: "Deploy production only from a saved immutable site version" },
        deps,
      );
      await addMemory(
        { text: "MongoDB invoices retain external payment identifiers" },
        deps,
      );

      const result = await recallMemory(
        {
          query: "Deploy production only from a saved immutable site version",
          limit: 5,
        },
        deps,
      );
      expect(result.claims.map((claim) => claim.id)).toEqual([relevant.id]);

      const db = (
        deps.store as unknown as { db: import("bun:sqlite").Database }
      ).db;
      const row = db
        .query(
          "SELECT query, returned_ids_json, result_count FROM recall_log ORDER BY id DESC LIMIT 1",
        )
        .get() as {
          query: string;
          returned_ids_json: string;
          result_count: number;
        };
      expect(row.query).toBe(
        "Deploy production only from a saved immutable site version",
      );
      expect(JSON.parse(row.returned_ids_json)).toEqual([relevant.id]);
      expect(row.result_count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("applies relevance floors before each scoped store limit", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      deps.provider = {
        model: "controlled",
        dim: 2,
        embed: async () => [new Float32Array([1, 0])],
      };
      for (let index = 0; index < 5; index += 1) {
        await deps.store.upsertClaim({
          id: `dual-ineligible-${index}`,
          kind: "fact",
          text: `deploy release now distractor ${index}`,
          embedding: new Float32Array([0.5, 0.866]),
          createdAt: index,
          skipDedup: true,
        });
      }
      await deps.store.upsertClaim({
        id: "exact-eligible",
        kind: "fact",
        text: "Configure GX_ONLY_TOKEN before deploy release now",
        embedding: new Float32Array([0, 1]),
        createdAt: 10,
        skipDedup: true,
      });

      const result = await recallMemory(
        {
          query: "GX_ONLY_TOKEN deploy release now",
          limit: 5,
          minCosine: 0.55,
          minLexicalScore: 0.75,
        },
        deps,
      );

      expect(result.claims.map((claim) => claim.id)).toEqual(["exact-eligible"]);
    } finally {
      cleanup();
    }
  });

  it("does not let below-floor procedure quota under-fill relevant results", async () => {
    const { deps, cleanup } = makeMemoryDeps();
    try {
      deps.provider = {
        model: "controlled",
        dim: 2,
        embed: async () => [new Float32Array([1, 0])],
      };
      for (let index = 0; index < 5; index += 1) {
        await deps.store.upsertClaim({
          id: `relevant-${index}`,
          kind: "lesson",
          text: `Relevant lesson ${index}`,
          embedding: new Float32Array([0.9 - index * 0.01, 0.1]),
          createdAt: index,
          skipDedup: true,
        });
      }
      for (let index = 0; index < 2; index += 1) {
        const id = `irrelevant-procedure-${index}`;
        await deps.store.upsertFact({
          id,
          kind: "procedure",
          body: `Irrelevant procedure ${index}`,
          createdAt: index,
        });
        await deps.store.upsertClaim({
          id,
          kind: "fact",
          text: `Irrelevant procedure ${index}`,
          embedding: new Float32Array([0.1, 0.9]),
          createdAt: index,
          skipDedup: true,
        });
      }

      const result = await recallMemory(
        {
          query: "relevant task",
          limit: 5,
          procedureQuota: 2,
          minCosine: 0.55,
        },
        deps,
      );
      expect(result.claims).toHaveLength(5);
      expect(result.claims.every((claim) => claim.id.startsWith("relevant-"))).toBe(
        true,
      );
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
        runContext: { agent: "default", channel: "C123", threadId: "111.222", signed: true },
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
      runContext: { agent: "default", channel: "C123", threadId: "111.222", signed: true },
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
