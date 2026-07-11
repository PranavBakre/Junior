/**
 * One-shot: read hermes-scoring mentor-links.csv and create a "Mentor Links"
 * child page (with a table) under the Hermes Notion page.
 *
 * Usage: bun run scripts/mentor-links-to-notion.ts
 * Env: NOTION_TOKEN (required), HERMES_NOTION_PAGE_ID (optional)
 */

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const CSV_PATH = "/Users/psbakre/Projects/hermes-scoring/mentor-links.csv";
const DEFAULT_PAGE_ID = "39a3578dc3f08015b386cc6638029bed";
const CHILD_PAGE_TITLE = "Mentor Links";

interface MentorLinkRow {
  city: string;
  name: string;
  role: string;
  token: string;
  link: string;
}

interface NotionRichText {
  type: "text";
  text: {
    content: string;
    link?: { url: string };
  };
}

type NotionTableCell = NotionRichText[];

interface NotionTableRowBlock {
  type: "table_row";
  table_row: {
    cells: NotionTableCell[];
  };
}

interface NotionTableBlock {
  type: "table";
  table: {
    table_width: number;
    has_column_header: boolean;
    has_row_header?: boolean;
    children: NotionTableRowBlock[];
  };
}

interface NotionChildPageBlock {
  object: "block";
  id: string;
  type: "child_page";
  child_page: {
    title: string;
  };
}

interface NotionBlockListResponse {
  object: "list";
  results: Array<{
    object: "block";
    id: string;
    type: string;
    child_page?: { title: string };
  }>;
  next_cursor: string | null;
  has_more: boolean;
}

interface NotionPageResponse {
  object: "page";
  id: string;
  url?: string;
}

function plainCell(content: string): NotionTableCell {
  return [{ type: "text", text: { content } }];
}

function linkCell(url: string): NotionTableCell {
  return [{ type: "text", text: { content: url, link: { url } } }];
}

function tableRow(cells: NotionTableCell[]): NotionTableRowBlock {
  return { type: "table_row", table_row: { cells } };
}

function headerRow(): NotionTableRowBlock {
  return tableRow([
    plainCell("City"),
    plainCell("Name"),
    plainCell("Role"),
    plainCell("Token"),
    plainCell("Link"),
  ]);
}

function rowToTableRow(row: MentorLinkRow): NotionTableRowBlock {
  return tableRow([
    plainCell(row.city),
    plainCell(row.name),
    plainCell(row.role),
    plainCell(row.token),
    linkCell(row.link),
  ]);
}

function pageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function parseCsv(text: string): MentorLinkRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error(`CSV at ${CSV_PATH} is empty`);
  }

  const header = lines[0]!.split(",");
  const expected = ["City", "Name", "Role", "Token", "Link"];
  if (header.length < 5 || expected.some((col, i) => header[i] !== col)) {
    throw new Error(
      `Unexpected CSV header: ${lines[0]!}. Expected: ${expected.join(",")}`,
    );
  }

  const rows: MentorLinkRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(",");
    if (parts.length < 5) {
      throw new Error(`CSV line ${i + 1} has fewer than 5 columns: ${lines[i]!}`);
    }
    // Link may contain no commas; join remainder for safety if any.
    const [city, name, role, token, ...linkParts] = parts;
    rows.push({
      city: city!,
      name: name!,
      role: role!,
      token: token!,
      link: linkParts.join(","),
    });
  }
  return rows;
}

async function notionFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return fetch(`${NOTION_API_BASE}${path}`, init);
}

async function assertOk(res: Response): Promise<void> {
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text();
    console.error(`Notion API error: ${res.status}`);
    console.error(body);
    process.exit(1);
  }
}

async function listChildBlocks(
  token: string,
  pageId: string,
): Promise<NotionBlockListResponse["results"]> {
  const all: NotionBlockListResponse["results"] = [];
  let cursor: string | null = null;

  for (;;) {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);

    const res = await notionFetch(
      token,
      "GET",
      `/blocks/${pageId}/children?${qs.toString()}`,
    );
    await assertOk(res);

    const data = (await res.json()) as NotionBlockListResponse;
    all.push(...data.results);

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return all;
}

function findMentorLinksPage(
  blocks: NotionBlockListResponse["results"],
): NotionChildPageBlock | null {
  for (const block of blocks) {
    if (
      block.type === "child_page" &&
      block.child_page?.title === CHILD_PAGE_TITLE
    ) {
      return block as NotionChildPageBlock;
    }
  }
  return null;
}

async function createMentorLinksPage(
  token: string,
  parentPageId: string,
  rows: MentorLinkRow[],
): Promise<NotionPageResponse> {
  const table: NotionTableBlock = {
    type: "table",
    table: {
      table_width: 5,
      has_column_header: true,
      has_row_header: false,
      children: [headerRow(), ...rows.map(rowToTableRow)],
    },
  };

  const res = await notionFetch(token, "POST", "/pages", {
    parent: { page_id: parentPageId },
    properties: {
      title: [
        {
          type: "text",
          text: { content: CHILD_PAGE_TITLE },
        },
      ],
    },
    children: [table],
  });
  await assertOk(res);
  return (await res.json()) as NotionPageResponse;
}

async function main(): Promise<void> {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error(
      "Missing NOTION_TOKEN. Set it to a Notion internal integration token and retry.",
    );
    process.exit(1);
  }

  const parentPageId =
    process.env.HERMES_NOTION_PAGE_ID?.trim() || DEFAULT_PAGE_ID;

  const csvText = await Bun.file(CSV_PATH).text();
  const rows = parseCsv(csvText);

  const children = await listChildBlocks(token, parentPageId);
  const existing = findMentorLinksPage(children);
  if (existing) {
    console.log(pageUrl(existing.id));
    process.exit(0);
  }

  const page = await createMentorLinksPage(token, parentPageId, rows);
  console.log(page.url ?? pageUrl(page.id));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
