import { describe, expect, it } from "bun:test";
import { searchAgentDefinitions } from "./slack-server.ts";

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
