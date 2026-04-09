import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface SlackFile {
  url: string;
  name: string;
  mimetype: string;
}

/**
 * Download image files from Slack to local disk so Claude can read them.
 * Only downloads image types; non-image files are silently skipped.
 * Returns array of local file paths for successfully downloaded files.
 */
export async function downloadSlackFiles(
  files: SlackFile[],
  threadId: string,
  botToken: string,
): Promise<string[]> {
  const imageFiles = files.filter((f) => IMAGE_TYPES.has(f.mimetype));
  if (imageFiles.length === 0) return [];

  const dir = join("/tmp", "junior-files", threadId);
  await mkdir(dir, { recursive: true });

  const paths: string[] = [];

  for (const file of imageFiles) {
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

      const filePath = join(dir, file.name);
      const buffer = await response.arrayBuffer();
      await Bun.write(filePath, buffer);
      paths.push(filePath);
    } catch (err) {
      console.error(`[files] Error downloading ${file.name}:`, err);
    }
  }

  return paths;
}
