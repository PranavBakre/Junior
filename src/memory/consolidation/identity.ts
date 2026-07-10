// Slack-identity resolution for consolidation (memory v3 §7).
//
// Source records identify people only as raw Slack ids (`actor_id = U03…`,
// mentions as `<@U0AB…>`), so without resolution the consolidation LLM cannot
// attribute evidence to a person or connect it to an existing person profile.
// This module extracts the ids a batch references and resolves them to display
// names through an injected resolver, keeping the engine free of Slack API
// dependencies (tests pass a fake; production wraps the cached
// `resolveUserName` helper).

import type { WebClient } from "@slack/web-api";

import { resolveUserName } from "../../slack/thread-context.ts";
import type { MemorySourceRecord } from "../types.ts";

/**
 * Resolve Slack user ids to display names. Ids that cannot be resolved are
 * simply absent from the returned map — never mapped to themselves.
 */
export type PeopleResolver = (slackUserIds: string[]) => Promise<Map<string, string>>;

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{4,}$/;
const SLACK_MENTION_RE = /<@([UW][A-Z0-9]{4,})>/g;

/**
 * Every Slack user id a record batch references: the author column when it
 * looks like a Slack id, plus `<@U…>` mentions inside bodies.
 */
export function referencedSlackUserIds(records: MemorySourceRecord[]): string[] {
  const ids = new Set<string>();
  for (const r of records) {
    if (r.actorId && SLACK_USER_ID_RE.test(r.actorId)) ids.add(r.actorId);
    for (const m of r.body.matchAll(SLACK_MENTION_RE)) ids.add(m[1]);
  }
  return [...ids];
}

/**
 * Production resolver: `users.info` via the shared per-process name cache.
 * `resolveUserName` falls back to the id itself on any failure, which carries
 * no information for the prompt — those entries are dropped.
 */
export function createSlackPeopleResolver(client: WebClient): PeopleResolver {
  return async (ids) => {
    const out = new Map<string, string>();
    for (const id of ids) {
      const name = await resolveUserName(client, id);
      if (name && name !== id) out.set(id, name);
    }
    return out;
  };
}
