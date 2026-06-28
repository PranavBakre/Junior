import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDocument, serializeDocument } from "./frontmatter.ts";
import { createProfileStore } from "./factory.ts";
import type { PersonProfile, RepoProfile } from "./types.ts";

function withTmp<T>(fn: (root: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "junior-profiles-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("frontmatter serialize/parse", () => {
  it("round-trips strings, string arrays, numbers, and prose body", () => {
    const fm = {
      kind: "profile/person",
      entity_ref: "pranav:person",
      role: "principal / architect",
      values: ["honesty", "speed"],
      count: 3,
    };
    const body = "Pranav is the principal.\n\nHe pushes back hard.";
    const text = serializeDocument(fm, body);
    const parsed = parseDocument(text);

    expect(parsed.frontmatter.kind).toBe("profile/person");
    expect(parsed.frontmatter.entity_ref).toBe("pranav:person");
    expect(parsed.frontmatter.role).toBe("principal / architect");
    expect(parsed.frontmatter.values).toEqual(["honesty", "speed"]);
    expect(parsed.frontmatter.count).toBe(3);
    expect(parsed.body).toBe(body);
  });

  it("handles empty arrays", () => {
    const text = serializeDocument({ triggers: [] }, "");
    expect(text).toContain("triggers: []");
    expect(parseDocument(text).frontmatter.triggers).toEqual([]);
  });

  it("quotes and round-trips values with commas, quotes, and colons", () => {
    const fm = {
      // colon inside a scalar stays bare (split on first colon only)
      comms_style: "terse: pushes back",
      // comma forces array-item quoting
      triggers: ["scope creep, again", 'said "idiot"'],
      // number-like string must stay a string, not become a number
      version: "2026",
    };
    const parsed = parseDocument(serializeDocument(fm, "body"));
    expect(parsed.frontmatter.comms_style).toBe("terse: pushes back");
    expect(parsed.frontmatter.triggers).toEqual(["scope creep, again", 'said "idiot"']);
    expect(parsed.frontmatter.version).toBe("2026");
    expect(typeof parsed.frontmatter.version).toBe("string");
  });

  it("preserves multi-line prose including blank lines", () => {
    const body = "Line one.\n\nLine two.\n  indented detail";
    const parsed = parseDocument(serializeDocument({ k: "v" }, body));
    expect(parsed.body).toBe(body);
  });

  it("preserves leading/trailing whitespace in a quoted scalar", () => {
    const parsed = parseDocument(serializeDocument({ note: "  padded  " }, ""));
    expect(parsed.frontmatter.note).toBe("  padded  ");
  });
});

describe("ProfileStore keyed path scheme", () => {
  it("writes person/repo/situation to the right kind folders", async () => {
    await withTmp(async (root) => {
      const store = createProfileStore({ root });
      await store.upsertProfile({ kind: "person", entity_ref: "pranav:person", role: "principal" });
      await store.upsertProfile({ kind: "repo", entity_ref: "gx-backend:repo", stack: "node" });
      await store.upsertProfile({
        kind: "situation",
        entity_ref: "merge-bypass:situation",
        pattern: "auto-merge to main",
      });

      expect(existsSync(join(root, "people", "pranav.md"))).toBe(true);
      expect(existsSync(join(root, "repos", "gx-backend.md"))).toBe(true);
      expect(existsSync(join(root, "situations", "merge-bypass.md"))).toBe(true);
    });
  });

  it("rejects malformed entity_refs", async () => {
    await withTmp(async (root) => {
      const store = createProfileStore({ root });
      await expect(
        store.upsertProfile({ kind: "person", entity_ref: "no-suffix" } as never),
      ).rejects.toThrow();
      await expect(store.fetchByEntityRef("../etc/passwd:person")).rejects.toThrow();
    });
  });
});

describe("ProfileStore write-then-fetch round-trip", () => {
  it("round-trips a full person profile incl. arrays and prose", async () => {
    await withTmp(async (root) => {
      const store = createProfileStore({ root, now: () => new Date("2026-06-28T00:00:00Z") });
      const input: Omit<PersonProfile, "updated_at"> = {
        kind: "person",
        entity_ref: "pranav:person",
        role: "principal / architect",
        comms_style: "terse, pushes back hard",
        values: ["honesty", "sharp diagnosis"],
        triggers: ["scope creep", "bypassing merge rules"],
        praises: ['honest "I was wrong"'],
        preferences: ["3-way merge"],
        relationship_trajectory: "warming",
        sentiment_trend: "neutral->positive",
        evidence: ["ep_1", "ep_2"],
        body: "Pranav is the principal.\n\nHe values terse answers.",
      };
      await store.upsertProfile(input);

      const fetched = (await store.fetchByEntityRef("pranav:person")) as PersonProfile;
      expect(fetched.kind).toBe("person");
      expect(fetched.entity_ref).toBe("pranav:person");
      expect(fetched.role).toBe("principal / architect");
      expect(fetched.values).toEqual(["honesty", "sharp diagnosis"]);
      expect(fetched.triggers).toEqual(["scope creep", "bypassing merge rules"]);
      expect(fetched.praises).toEqual(['honest "I was wrong"']);
      expect(fetched.relationship_trajectory).toBe("warming");
      expect(fetched.evidence).toEqual(["ep_1", "ep_2"]);
      expect(fetched.body).toBe(input.body);
      expect(fetched.updated_at).toBe("2026-06-28");
    });
  });

  it("round-trips a repo profile", async () => {
    await withTmp(async (root) => {
      const store = createProfileStore({ root });
      const input: Omit<RepoProfile, "updated_at" | "evidence"> = {
        kind: "repo",
        entity_ref: "gx-backend:repo",
        conventions: ["npm not bun", "3-way merge"],
        gotchas: ["dev poisons main on squash"],
        merge_flow: "feature -> dev -> main",
        owners: ["pranav:person"],
        stack: "node/express/mongo",
        hot_paths: ["src/learning_chunk"],
        body: "GX backend on port 8000.",
      };
      await store.upsertProfile(input);

      const fetched = (await store.fetchByEntityRef("gx-backend:repo")) as RepoProfile;
      expect(fetched.conventions).toEqual(["npm not bun", "3-way merge"]);
      expect(fetched.merge_flow).toBe("feature -> dev -> main");
      expect(fetched.owners).toEqual(["pranav:person"]);
      expect(fetched.evidence).toEqual([]);
    });
  });

  it("returns null for a missing entity", async () => {
    await withTmp(async (root) => {
      const store = createProfileStore({ root });
      expect(await store.fetchByEntityRef("nobody:person")).toBeNull();
    });
  });
});

describe("ProfileStore merge/update", () => {
  it("preserves untouched fields, unions evidence, and bumps updated_at", async () => {
    await withTmp(async (root) => {
      let day = 1;
      const store = createProfileStore({
        root,
        now: () => new Date(Date.UTC(2026, 5, day)),
      });

      day = 1;
      await store.upsertProfile({
        kind: "person",
        entity_ref: "pranav:person",
        role: "principal",
        comms_style: "terse",
        triggers: ["scope creep"],
        evidence: ["ep_1"],
        body: "First sketch.",
      });

      day = 5;
      const updated = (await store.upsertProfile({
        kind: "person",
        entity_ref: "pranav:person",
        // only update triggers + add evidence; role/comms_style/body must persist
        triggers: ["scope creep", "merge bypass"],
        evidence: ["ep_1", "ep_2"],
      })) as PersonProfile;

      expect(updated.role).toBe("principal");
      expect(updated.comms_style).toBe("terse");
      expect(updated.body).toBe("First sketch.");
      expect(updated.triggers).toEqual(["scope creep", "merge bypass"]);
      // union, no duplicate ep_1
      expect(updated.evidence).toEqual(["ep_1", "ep_2"]);
      expect(updated.updated_at).toBe("2026-06-05");

      // persisted on disk too
      const onDisk = (await store.fetchByEntityRef("pranav:person")) as PersonProfile;
      expect(onDisk.role).toBe("principal");
      expect(onDisk.evidence).toEqual(["ep_1", "ep_2"]);
      expect(onDisk.updated_at).toBe("2026-06-05");
    });
  });

  it("overwrites prose body when provided", async () => {
    await withTmp(async (root) => {
      const store = createProfileStore({ root });
      await store.upsertProfile({ kind: "person", entity_ref: "x:person", body: "old" });
      const updated = await store.upsertProfile({ kind: "person", entity_ref: "x:person", body: "new" });
      expect(updated.body).toBe("new");
    });
  });
});

describe("ProfileStore list", () => {
  it("lists by kind and across all kinds", async () => {
    await withTmp(async (root) => {
      const store = createProfileStore({ root });
      await store.upsertProfile({ kind: "person", entity_ref: "a:person" });
      await store.upsertProfile({ kind: "person", entity_ref: "b:person" });
      await store.upsertProfile({ kind: "repo", entity_ref: "r:repo" });

      const people = await store.list("person");
      expect(people.map((p) => p.entity_ref).sort()).toEqual(["a:person", "b:person"]);

      const repos = await store.list("repo");
      expect(repos.map((p) => p.entity_ref)).toEqual(["r:repo"]);

      const all = await store.list();
      expect(all.length).toBe(3);

      // empty kind folder yields []
      expect(await store.list("situation")).toEqual([]);
    });
  });

  it("emits the §6.1 frontmatter shape on disk", async () => {
    await withTmp(async (root) => {
      const store = createProfileStore({ root, now: () => new Date("2026-06-28T00:00:00Z") });
      await store.upsertProfile({
        kind: "person",
        entity_ref: "pranav:person",
        role: "principal",
        triggers: ["scope creep"],
        evidence: ["ep_1"],
        body: "sketch",
      });
      const raw = readFileSync(join(root, "people", "pranav.md"), "utf8");
      expect(raw.startsWith("---\n")).toBe(true);
      expect(raw).toContain("kind: profile/person");
      expect(raw).toContain("entity_ref: pranav:person");
      expect(raw).toContain("triggers: [scope creep]");
      expect(raw).toContain("evidence: [ep_1]");
      expect(raw).toContain("updated_at: 2026-06-28");
      expect(raw.trimEnd().endsWith("sketch")).toBe(true);
    });
  });
});
