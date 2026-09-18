/** Cached set of the workspace's public channel IDs, fetched with paginated conversations.list. */

interface ConversationsListPage {
  ok?: boolean;
  error?: string;
  channels?: { id?: string; is_channel?: boolean; is_private?: boolean }[];
  response_metadata?: { next_cursor?: string };
}

export interface PublicChannelLister {
  conversations: {
    list(args: {
      types: string;
      limit: number;
      exclude_archived: boolean;
      cursor?: string;
    }): Promise<ConversationsListPage>;
  };
}

export interface PublicChannelDirectory {
  isPublic(channelId: string): Promise<boolean>;
}

const DEFAULT_TTL_MS = 5 * 60_000;

export function createPublicChannelDirectory(
  client: () => PublicChannelLister,
  options: { ttlMs?: number; now?: () => number } = {},
): PublicChannelDirectory {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { ids: Set<string>; fetchedAt: number } | null = null;
  let inFlight: Promise<Set<string>> | null = null;

  async function fetchAll(): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client().conversations.list({
        types: "public_channel",
        limit: 1_000,
        exclude_archived: false,
        cursor,
      });
      if (page.ok === false) throw new Error(`conversations.list failed: ${page.error ?? "unknown_error"}`);
      for (const channel of page.channels ?? []) {
        if (channel.id && channel.is_channel === true && channel.is_private !== true) ids.add(channel.id);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return ids;
  }

  async function publicIds(): Promise<Set<string>> {
    if (cached && now() - cached.fetchedAt < ttlMs) return cached.ids;
    inFlight ??= fetchAll()
      .then((ids) => {
        cached = { ids, fetchedAt: now() };
        return ids;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    async isPublic(channelId) {
      try {
        return (await publicIds()).has(channelId);
      } catch {
        return false;
      }
    },
  };
}
