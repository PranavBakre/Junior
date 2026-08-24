import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SlackFileAttachment } from "./events.ts";

export interface SlackFile {
  url: string;
  name: string;
  mimetype: string;
}

/**
 * Durable pipeline state must not accept an unbounded copy of a Slack event.
 * Keep the existing attachment contract, but cap both collection and field
 * sizes before it crosses the assignment/outbox boundary.
 */
export const MAX_DURABLE_SLACK_FILES = 8;
export const MAX_DURABLE_SLACK_FILE_URL = 2_048;
export const MAX_DURABLE_SLACK_FILE_NAME = 256;
export const MAX_DURABLE_SLACK_FILE_MIMETYPE = 128;

export function boundSlackFileAttachments(
  files: readonly SlackFileAttachment[] | undefined,
): SlackFileAttachment[] {
  if (!files?.length) return [];
  return files
    .slice(0, MAX_DURABLE_SLACK_FILES)
    .map((file) => ({
      url: file.url.trim().slice(0, MAX_DURABLE_SLACK_FILE_URL),
      name: file.name.slice(0, MAX_DURABLE_SLACK_FILE_NAME),
      mimetype: file.mimetype.slice(0, MAX_DURABLE_SLACK_FILE_MIMETYPE),
    }))
    .filter((file) => file.url.length > 0 && file.name.length > 0);
}

/** Validate JSON restored from a pipeline outbox before it becomes an event. */
export function parseSlackFileAttachments(value: unknown): SlackFileAttachment[] {
  if (!Array.isArray(value)) return [];
  const files: SlackFileAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const file = item as Record<string, unknown>;
    if (
      typeof file.url !== "string" ||
      typeof file.name !== "string" ||
      typeof file.mimetype !== "string"
    ) continue;
    files.push({
      url: file.url,
      name: file.name,
      mimetype: file.mimetype,
    });
  }
  return boundSlackFileAttachments(files);
}

/**
 * Slack filenames are user-controlled. Angle brackets and quotes can forge
 * prompt structure (e.g. `<buffered-message from="...">`) once the path is
 * echoed into the runner prompt — and are illegal in filenames on most
 * filesystems anyway. Replace them before writing so the on-disk path itself
 * is clean and the prompt can quote it verbatim.
 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[<>"]/g, "_");
}

/**
 * Download Slack files to local disk so the runner can read them.
 * Returns array of local file paths for successfully downloaded files.
 */
export async function downloadSlackFiles(
  files: SlackFile[],
  threadId: string,
  botToken: string,
): Promise<string[]> {
  const dir = join("/tmp", "junior-files", threadId);
  await mkdir(dir, { recursive: true });

  const paths: string[] = [];

  for (const file of files) {
    try {
      const response = await fetch(file.url, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) {
        console.error(
          `[files] Failed to download ${file.name}: ${response.status} ${response.statusText}`,
        );
        continue;
      }

      const filePath = join(dir, sanitizeFileName(basename(file.name)));
      const buffer = await response.arrayBuffer();
      await Bun.write(filePath, buffer);
      paths.push(filePath);
    } catch (err) {
      console.error(`[files] Error downloading ${file.name}:`, err);
    }
  }

  return paths;
}
