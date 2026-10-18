import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createAcruxCoreMcpServer } from '../../src/server';
import type { McpServerConfig, Toolset } from '../../src/config';
import { ALL_TOOLSETS } from '../../src/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signupTestUserWithApiKey } = require('../../../../apps/api/src/test-utils/auth');

/** The real Express app, shared across a suite — it holds no per-test state. */
export const app = createApp();

/** Everything one test needs, plus the teardown that closes all of it. */
export interface Harness {
  /** MCP client, already connected and initialized. */
  client: Client;
  /** The team's API key, for arranging fixtures over plain REST. */
  apiKey: string;
  /** Base URL of the live app, for the same. */
  baseUrl: string;
  /** Team id, for asserting database state directly. */
  teamId: string;
  /** Closes the MCP client, the MCP server and the HTTP listener. */
  close: () => Promise<void>;
}

/**
 * Boots the whole chain a real user goes through and hands back a connected MCP client.
 *
 * The point of doing it this way rather than stubbing the REST layer: the assertions
 * below then cover MCP client → MCP server → REST client → Express → service → Prisma →
 * Postgres in one pass. A mocked HTTP client would test that our tools call the URLs we
 * think they call, which is the one thing that cannot actually be wrong on its own.
 *
 * @param overrides - Config fields to change, e.g. `readOnly` or `toolsets`.
 * @returns A live harness. Always `close()` it, or Jest will not exit.
 */
export async function startHarness(
  overrides: Partial<Omit<McpServerConfig, 'apiKey' | 'baseUrl'>> = {},
): Promise<Harness> {
  const ctx = await signupTestUserWithApiKey(app);

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const config: McpServerConfig = {
    baseUrl,
    apiKey: ctx.apiKey,
    toolsets: [...ALL_TOOLSETS] as Toolset[],
    readOnly: false,
    promptAlias: 'production',
    maxTextBytes: 200_000,
    timeoutMs: 30_000,
    ...overrides,
  };

  const { server } = createAcruxCoreMcpServer(config);
  const client = new Client({ name: 'integration-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    apiKey: ctx.apiKey,
    baseUrl,
    teamId: ctx.teamId,
    close: async () => {
      await client.close();
      await server.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Calls a tool and returns its first text block, failing loudly if the tool errored.
 *
 * @param client - Connected MCP client.
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @returns The text content of the result.
 * @throws {Error} If the tool returned `isError`, with the error text — otherwise a
 *   failing assertion downstream would show only "undefined" and hide the real cause.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = textOf(result);
  if (result.isError) throw new Error(`Tool "${name}" failed: ${text}`);
  return text;
}

/**
 * Calls a tool that is expected to fail and returns its error text.
 *
 * @param client - Connected MCP client.
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @returns The error text.
 * @throws {Error} If the tool unexpectedly succeeded.
 */
export async function callToolExpectingError(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (!result.isError) throw new Error(`Tool "${name}" was expected to fail but succeeded.`);
  return textOf(result);
}

/** Concatenates the text blocks of a tool result. */
export function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Extracts the JSON payload {@link okResult} appends after the summary line.
 *
 * @param text - A tool result's text.
 * @returns The parsed payload.
 * @throws {Error} If the text carries no JSON body.
 */
export function payloadOf<T = Record<string, unknown>>(text: string): T {
  const start = text.indexOf('\n\n');
  if (start === -1) throw new Error(`Result has no JSON payload:\n${text}`);
  return JSON.parse(text.slice(start + 2)) as T;
}

/**
 * Issues a plain REST call with the harness's API key.
 *
 * Used to arrange fixtures the MCP surface deliberately does not expose (trace
 * ingestion, for one) without reaching into Prisma and bypassing validation.
 *
 * @param harness - The live harness.
 * @param method - HTTP verb.
 * @param path - Path below `/api/v1`.
 * @param body - Optional JSON body.
 * @returns The parsed response body.
 * @throws {Error} On a non-2xx response, with the body text.
 */
export async function rest<T = unknown>(
  harness: Pick<Harness, 'apiKey' | 'baseUrl'>,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${harness.apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
