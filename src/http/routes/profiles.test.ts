import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../../memory/profiles/store.ts";
import { handleProfiles } from "./profiles.ts";

describe("profiles HTTP route", () => {
  it("lists profiles without recording dashboard inspection as usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "junior-http-profiles-"));
    try {
      const store = new ProfileStore({ root });
      await store.upsertProfile({ kind: "person", entity_ref: "alex:person", role: "operator" });
      await store.upsertProfile({ kind: "repo", entity_ref: "junior:repo", stack: "Bun" });

      const response = await handleProfiles(store, new URLSearchParams());
      expect(response.status).toBe(200);
      const body = await response.json() as {
        profiles: Array<{ entity_ref: string; last_used_at?: number | null }>;
        counts: Record<string, number>;
      };
      expect(body.profiles.map((profile) => profile.entity_ref)).toEqual(["alex:person", "junior:repo"]);
      expect(body.counts).toEqual({ person: 1, repo: 1, project: 0, situation: 0 });
      expect(body.profiles.every((profile) => profile.last_used_at == null)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters by kind and rejects unknown kinds", async () => {
    const root = mkdtempSync(join(tmpdir(), "junior-http-profiles-"));
    try {
      const store = new ProfileStore({ root });
      await store.upsertProfile({ kind: "situation", entity_ref: "blocked-release:situation" });
      const filtered = await handleProfiles(store, new URLSearchParams({ kind: "situation" }));
      expect((await filtered.json() as { profiles: unknown[] }).profiles).toHaveLength(1);
      expect((await handleProfiles(store, new URLSearchParams({ kind: "unknown" }))).status).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
