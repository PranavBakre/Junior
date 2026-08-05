import type { ProfileStore } from "../../memory/profiles/store.ts";
import type { ProfileKind } from "../../memory/profiles/types.ts";

const PROFILE_KINDS = new Set<ProfileKind>(["person", "repo", "project", "situation"]);

/** Read-only profile browser. Inspection deliberately does not bump last_used_at. */
export async function handleProfiles(
  store: ProfileStore,
  params: URLSearchParams,
): Promise<Response> {
  const rawKind = params.get("kind");
  if (rawKind && !PROFILE_KINDS.has(rawKind as ProfileKind)) {
    return Response.json({ error: "invalid profile kind" }, { status: 400 });
  }

  const profiles = await store.list(rawKind as ProfileKind | undefined);
  profiles.sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at) || a.entity_ref.localeCompare(b.entity_ref)
  );
  const counts = { person: 0, repo: 0, project: 0, situation: 0 };
  for (const profile of profiles) counts[profile.kind] += 1;
  return Response.json({ profiles, counts });
}
