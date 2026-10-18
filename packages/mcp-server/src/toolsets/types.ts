import type { z, ZodRawShape } from 'zod';
import type { AcruxCoreClient } from '../client';
import type { McpServerConfig, Toolset } from '../config';
import type { ToolResult } from '../format';

/** Everything a tool handler is given besides its own arguments. */
export interface ToolContext {
  /** REST client already carrying the caller's API key. */
  client: AcruxCoreClient;
  /** Resolved server configuration — handlers read `maxTextBytes` from it. */
  config: McpServerConfig;
}

/**
 * A registered tool, erased to a uniform shape so every toolset can live in one array.
 *
 * `handler` takes `unknown` here; {@link defineTool} does the one cast that restores the
 * inferred argument type at each definition site, so no individual tool needs `any`.
 */
export interface AnyToolDefinition {
  /** Tool name as the client sees it. Snake case, verb first. */
  name: string;
  /** Short human title for clients that show one. */
  title: string;
  /** What the model reads to decide whether to call this tool. */
  description: string;
  /** Zod raw shape for the arguments. */
  inputSchema: ZodRawShape;
  /** Which toolset this belongs to. */
  toolset: Toolset;
  /** False for anything that writes. Mutating tools are dropped in read-only mode. */
  readOnlyHint: boolean;
  /** True when a call can remove or overwrite something a user would miss. */
  destructiveHint?: boolean;
  /** Runs the tool. */
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Declares a tool with its argument type inferred from the Zod shape.
 *
 * @param def - The tool definition; `handler` receives arguments typed from `inputSchema`.
 * @returns The same definition, erased to {@link AnyToolDefinition}.
 */
export function defineTool<Shape extends ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  toolset: Toolset;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<ToolResult>;
}): AnyToolDefinition {
  return {
    ...def,
    handler: (args, ctx) => def.handler(args as z.infer<z.ZodObject<Shape>>, ctx),
  };
}
