import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

type ProjectZodShape = Record<string, z.ZodType>;
type ProjectInputSchema = ProjectZodShape | z.ZodType;

type ParsedToolInput<Schema extends ProjectInputSchema> =
  Schema extends z.ZodType
    ? z.output<Schema>
    : Schema extends ProjectZodShape
      ? { [Key in keyof Schema]: z.output<Schema[Key]> }
      : never;

interface ProjectToolConfig<Schema extends ProjectInputSchema> {
  title?: string;
  description?: string;
  inputSchema: Schema;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
}

/**
 * Keep the SDK's Zod compatibility cast at one registration boundary.
 *
 * Bun can install a second physical Zod copy beneath the MCP SDK. Zod's
 * branded types then become nominally incompatible even though the schemas
 * are runtime-compatible. Callers retain inference from the project's Zod
 * schemas; only the handoff to the SDK is intentionally erased.
 */
export function registerTool<Schema extends ProjectInputSchema>(
  server: McpServer,
  name: string,
  config: ProjectToolConfig<Schema>,
  callback: (args: ParsedToolInput<Schema>) => unknown,
): void {
  const sdkRegisterTool = server.registerTool.bind(server) as unknown as (
    toolName: string,
    toolConfig: unknown,
    toolCallback: unknown,
  ) => void;

  sdkRegisterTool(name, config, callback);
}
