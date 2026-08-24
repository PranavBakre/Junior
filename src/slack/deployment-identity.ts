import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WebClient } from "@slack/web-api";

export interface SlackDeploymentIdentity {
  userId: string;
  botId: string | null;
  teamId: string | null;
  workspaceUrl: string | null;
  visibleName: string;
  joinedChannelIds: string[];
}

export interface ExpectedSlackDeploymentIdentity {
  userId: string;
  botId?: string | null;
  teamId?: string | null;
  visibleName?: string;
  joinedChannelIds?: string[];
}

export interface SlackIdentityClient {
  auth: { test(): Promise<Record<string, unknown>> };
  users: { info(args: { user: string }): Promise<Record<string, unknown>> };
  conversations: {
    list(args: { types: string; limit: number; cursor?: string }): Promise<Record<string, unknown>>;
  };
}

export interface SlackIdentityCheck {
  identity: SlackDeploymentIdentity;
  errors: string[];
}

export interface SlackIdentityConfig {
  expectedUserId?: string | null;
  expectedBotId?: string | null;
  expectedTeamId?: string | null;
  expectedVisibleName?: string | null;
  expectedChannelIds?: string[];
}

export const DEFAULT_SLACK_IDENTITY_PATH = "data/slack-deployment-identity.json";

export function expectedSlackDeploymentIdentity(
  config: SlackIdentityConfig,
  persisted: ExpectedSlackDeploymentIdentity | null,
): ExpectedSlackDeploymentIdentity | null {
  const configured = config.expectedUserId?.trim() ? {
    userId: config.expectedUserId.trim(),
    ...(config.expectedBotId ? { botId: config.expectedBotId } : {}),
    ...(config.expectedTeamId ? { teamId: config.expectedTeamId } : {}),
    ...(config.expectedVisibleName ? { visibleName: config.expectedVisibleName } : {}),
    ...(config.expectedChannelIds?.length ? { joinedChannelIds: config.expectedChannelIds } : {}),
  } : null;
  return configured ?? persisted;
}

export async function fetchSlackDeploymentIdentity(
  client: SlackIdentityClient | WebClient,
): Promise<SlackDeploymentIdentity> {
  const auth = await client.auth.test();
  if (auth.ok === false) {
    throw new Error(`Slack auth.test failed: ${stringField(auth, "error") ?? "unknown error"}`);
  }
  const userId = stringField(auth, "user_id");
  if (!userId) throw new Error("Slack auth.test did not return user_id");

  const userResult = await client.users.info({ user: userId });
  if (userResult.ok === false) {
    throw new Error(`Slack users.info(${userId}) failed: ${stringField(userResult, "error") ?? "unknown error"}`);
  }
  const user = recordField(userResult, "user");
  const profile = user ? recordField(user, "profile") : null;
  const visibleName =
    stringField(profile, "display_name")?.trim() ||
    stringField(profile, "real_name")?.trim() ||
    stringField(user, "real_name")?.trim() ||
    stringField(user, "name")?.trim();
  if (!visibleName) throw new Error(`Slack users.info(${userId}) has no visible name`);

  const joinedChannelIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (result.ok === false) {
      throw new Error(`Slack conversations.list failed: ${stringField(result, "error") ?? "unknown error"}`);
    }
    const channels = Array.isArray(result.channels) ? result.channels : [];
    for (const value of channels) {
      const channel = asRecord(value);
      if (channel?.is_member === true && typeof channel.id === "string") {
        joinedChannelIds.add(channel.id);
      }
    }
    const metadata = asRecord(result.response_metadata);
    cursor = stringField(metadata, "next_cursor")?.trim() || undefined;
  } while (cursor);

  return {
    userId,
    botId: stringField(auth, "bot_id"),
    teamId: stringField(auth, "team_id"),
    workspaceUrl: stringField(auth, "url"),
    visibleName,
    joinedChannelIds: [...joinedChannelIds].sort(),
  };
}

export function compareSlackDeploymentIdentity(
  actual: SlackDeploymentIdentity,
  expected: ExpectedSlackDeploymentIdentity | null,
): SlackIdentityCheck {
  const errors: string[] = [];
  if (!expected) {
    errors.push("no expected Slack deployment identity is pinned; run `bun run slack:identity:setup`");
  } else {
    if (actual.userId !== expected.userId) {
      errors.push(`user_id mismatch (expected ${expected.userId}, got ${actual.userId})`);
    }
    if (expected.botId !== undefined && actual.botId !== expected.botId) {
      errors.push(`bot_id mismatch (expected ${expected.botId ?? "none"}, got ${actual.botId ?? "none"})`);
    }
    if (expected.teamId !== undefined && actual.teamId !== expected.teamId) {
      errors.push(`team_id mismatch (expected ${expected.teamId ?? "none"}, got ${actual.teamId ?? "none"})`);
    }
    if (expected.visibleName !== undefined && actual.visibleName !== expected.visibleName) {
      errors.push(`visible name mismatch (expected ${JSON.stringify(expected.visibleName)}, got ${JSON.stringify(actual.visibleName)})`);
    }
    for (const channelId of expected.joinedChannelIds ?? []) {
      if (!actual.joinedChannelIds.includes(channelId)) {
        errors.push(`bot is not joined to expected channel ${channelId}`);
      }
    }
  }
  return { identity: actual, errors };
}

export function loadExpectedSlackDeploymentIdentity(
  path = DEFAULT_SLACK_IDENTITY_PATH,
): ExpectedSlackDeploymentIdentity | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
    const record = asRecord(parsed);
    if (!record || typeof record.userId !== "string" || !record.userId.trim()) {
      throw new Error("expected identity must contain a non-empty userId");
    }
    return {
      userId: record.userId,
      ...(typeof record.botId === "string" || record.botId === null ? { botId: record.botId } : {}),
      ...(typeof record.teamId === "string" || record.teamId === null ? { teamId: record.teamId } : {}),
      ...(typeof record.visibleName === "string" ? { visibleName: record.visibleName } : {}),
      ...(Array.isArray(record.joinedChannelIds)
        ? { joinedChannelIds: record.joinedChannelIds.filter((id): id is string => typeof id === "string") }
        : {}),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function persistExpectedSlackDeploymentIdentity(
  identity: ExpectedSlackDeploymentIdentity,
  path = DEFAULT_SLACK_IDENTITY_PATH,
): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  return asRecord(asRecord(value)?.[key]);
}

function stringField(value: unknown, key: string): string | null {
  const candidate = asRecord(value)?.[key];
  return typeof candidate === "string" && candidate ? candidate : null;
}
