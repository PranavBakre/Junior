import { describe, expect, it } from "bun:test";
import {
  newRelicNrqlCommand,
  sentryListCommand,
  vercelReadCommand,
} from "./read-only-cli.ts";

describe("read-only observability command builders", () => {
  it("builds a bounded New Relic query without a shell", () => {
    expect(newRelicNrqlCommand({
      accountId: 123,
      query: "FROM Transaction SELECT count(*) SINCE 1 hour ago",
    })).toEqual([
      "newrelic",
      "nrql",
      "query",
      "--accountId",
      "123",
      "--query",
      "FROM Transaction SELECT count(*) SINCE 1 hour ago",
      "--format",
      "JSON",
    ]);
    expect(() => newRelicNrqlCommand({
      query: "DELETE FROM Metric",
    })).toThrow("read-only");
  });

  it("exposes only Sentry list commands", () => {
    expect(sentryListCommand({
      resource: "issues",
      organization: "growthx",
      project: "api",
      query: "is:unresolved",
      maxRows: 25,
    })).toEqual([
      "sentry-cli",
      "issues",
      "list",
      "--org",
      "growthx",
      "--max-rows",
      "25",
      "--project",
      "api",
      "--query",
      "is:unresolved",
    ]);
  });

  it("never enables Vercel follow or a mutating subcommand", () => {
    const command = vercelReadCommand({
      operation: "logs",
      project: "frontend",
      since: "1h",
      limit: 50,
    });
    expect(command.slice(0, 2)).toEqual(["vercel", "logs"]);
    expect(command).toContain("--no-follow");
    expect(command).not.toContain("--follow");
    expect(command).not.toContain("deploy");
    expect(() => vercelReadCommand({
      operation: "inspect",
      deployment: "--token",
    })).toThrow("valid identifier");
  });
});
