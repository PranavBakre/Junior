// Thin wrapper over @notionhq/client v5.23.0 (CLAUDE.md rule 14 -- no ceremony
// beyond what sync.ts actually needs).
//
// v5 targets Notion API version 2025-09-03+, where databases hold one or more
// "data sources" and page schema properties technically live on the data
// source, not the database. We don't touch multi-data-source databases here:
// `databases.create` still takes an `initial_data_source` and pages can still
// be parented directly on `database_id` (CreatePageParameters keeps a
// `database_id` parent variant alongside the new `data_source_id` one), so a
// single-data-source database is all this module needs -- see sync.ts for
// where that assumption is load-bearing.
import { Client } from "@notionhq/client";
import type {
  CreateDatabaseParameters,
  CreateDatabaseResponse,
  CreatePageParameters,
  CreatePageResponse,
  GetDatabaseParameters,
  GetDatabaseResponse,
  ListBlockChildrenParameters,
  ListBlockChildrenResponse,
  QueryDataSourceParameters,
  QueryDataSourceResponse,
  UpdateDataSourceParameters,
  UpdateDataSourceResponse,
  UpdatePageParameters,
  UpdatePageResponse,
} from "@notionhq/client";

/**
 * The subset of the Notion client that sync.ts depends on. Narrowing to an
 * interface (rather than importing the concrete `Client` class) is what lets
 * tests inject a fake client with no network access -- see notion/sync.test.ts.
 */
export interface NotionApi {
  blocks: {
    children: {
      list(args: ListBlockChildrenParameters): Promise<ListBlockChildrenResponse>;
    };
  };
  databases: {
    retrieve(args: GetDatabaseParameters): Promise<GetDatabaseResponse>;
    create(args: CreateDatabaseParameters): Promise<CreateDatabaseResponse>;
  };
  dataSources: {
    query(args: QueryDataSourceParameters): Promise<QueryDataSourceResponse>;
    update(args: UpdateDataSourceParameters): Promise<UpdateDataSourceResponse>;
  };
  pages: {
    create(args: CreatePageParameters): Promise<CreatePageResponse>;
    update(args: UpdatePageParameters): Promise<UpdatePageResponse>;
  };
}

/**
 * Real `Client` instances satisfy `NotionApi` structurally (they expose a
 * superset of these methods), so this factory can return the interface type
 * directly without a manual wrapper object.
 *
 * Retry is disabled here (`retry: false`): the SDK's own automatic retry
 * (default maxRetries: 2, already Retry-After aware) would otherwise sit
 * underneath sync.ts's own single-retry-on-429 logic, doubling retries and
 * making that behavior untestable against a fake client. sync.ts owns retry
 * policy so it stays a plain, unit-testable function.
 */
export function createNotionClient(token: string): NotionApi {
  return new Client({ auth: token, retry: false });
}
