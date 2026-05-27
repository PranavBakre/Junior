import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

export interface SlackFile {
  url: string;
  name: string;
  mimetype: string;
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

      const filePath = join(dir, basename(file.name));
      const buffer = await response.arrayBuffer();
      await Bun.write(filePath, buffer);
      paths.push(filePath);
    } catch (err) {
      console.error(`[files] Error downloading ${file.name}:`, err);
    }
  }

  return paths;
}
