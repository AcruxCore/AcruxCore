import http from 'http';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { resetAuthTables, signupTestUserWithApiKey } from '../test-utils';
import { setSelfBaseUrl } from './mcp.types';

const app = createApp();

let server: http.Server;
let origin: string;
let apiKey: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  // The hosted endpoint's tools call this same API over loopback. server.ts does this
  // from its listen callback; a test that imports createApp() directly must do it too,
  // or every tool call would go to whatever PORT happens to be in the environment.
  setSelfBaseUrl(`${origin}/api/v1`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetAuthTables();
  const ctx = await signupTestUserWithApiKey(app);
  apiKey = ctx.apiKey;
});

/**
 * Connects a real MCP client to the hosted endpoint over Streamable HTTP.
 *
 * The official client rather than hand-built JSON-RPC frames: the transport's own
 * `Accept` and `MCP-Protocol-Version` header rules are part of what this endpoint has to
 * satisfy, and a hand-rolled request would quietly test a protocol nobody speaks.
 *
 * @param key - Bearer token to authenticate with.
 * @returns A connected client and its closer.
 */
async function connect(key: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: 'mcp-endpoint-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe('POST /api/v1/mcp — hosted Model Context Protocol endpoint', () => {
  it('rejects a request with no API key', async () => {
    const res = await request(server)
      .post('/api/v1/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a revoked or unknown API key', async () => {
    const res = await request(server)
      .post('/api/v1/mcp')
      .set('Authorization', 'Bearer acx_sk_not_a_real_key')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    expect(res.status).toBe(401);
  });

  it('completes the handshake and lists the full tool surface', async () => {
    const { client, close } = await connect(apiKey);
    try {
      expect(client.getServerVersion()?.name).toBe('acruxcore');

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toEqual(
        expect.arrayContaining(['list_prompts', 'run_prompt', 'search_traces', 'list_datasets']),
      );
    } finally {
      await close();
    }
  });

  it('runs a real tool call end to end, through the API and into Postgres', async () => {
    const { client, close } = await connect(apiKey);
    try {
      const created = (await client.callTool({
        name: 'create_prompt',
        arguments: { name: 'hosted-endpoint-prompt', description: 'via MCP over HTTP' },
      })) as CallToolResult;

      expect(created.isError).toBeFalsy();

      const row = await prisma.prompt.findFirst({ where: { name: 'hosted-endpoint-prompt' } });
      expect(row).not.toBeNull();
      expect(row?.description).toBe('via MCP over HTTP');
    } finally {
      await close();
    }
  });

  it('scopes everything to the calling key\'s team', async () => {
    const other = await signupTestUserWithApiKey(app);

    const first = await connect(apiKey);
    try {
      await first.client.callTool({
        name: 'create_prompt',
        arguments: { name: 'team-one-prompt' },
      });
    } finally {
      await first.close();
    }

    const second = await connect(other.apiKey);
    try {
      const listed = (await second.client.callTool({
        name: 'list_prompts',
        arguments: {},
      })) as CallToolResult;
      const text = (listed.content[0] as { text: string }).text;
      expect(text).toContain('No prompts found.');
    } finally {
      await second.close();
    }
  });

  it('exposes the registry prompts primitive over HTTP too', async () => {
    const { client, close } = await connect(apiKey);
    try {
      await client.callTool({ name: 'create_prompt', arguments: { name: 'hosted-greeting' } });
      await client.callTool({
        name: 'commit_prompt_version',
        arguments: {
          prompt: 'hosted-greeting',
          messages: [{ role: 'user', content: 'Hi {{ name }}.' }],
        },
      });

      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toContain('hosted-greeting');

      const rendered = await client.getPrompt({
        name: 'hosted-greeting',
        arguments: { name: 'Ada' },
      });
      expect((rendered.messages[0].content as { text: string }).text).toBe('Hi Ada.');
    } finally {
      await close();
    }
  });

  it('answers GET and DELETE with 405 rather than holding a stream open', async () => {
    // Left to the transport, GET would open an SSE stream and wait forever for
    // notifications a stateless server can never send.
    const get = await request(server)
      .get('/api/v1/mcp')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Accept', 'text/event-stream');
    expect(get.status).toBe(405);
    expect(get.body.error.message).toContain('stateless');

    const del = await request(server).delete('/api/v1/mcp').set('Authorization', `Bearer ${apiKey}`);
    expect(del.status).toBe(405);
  });
});
