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
 * @param query - Optional query string, starting with `?`, holding the endpoint's options.
 * @returns A connected client and its closer.
 */
async function connect(
  key: string,
  query = '',
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: 'mcp-endpoint-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp${query}`), {
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

  it('takes the same options as the local server, as query parameters', async () => {
    const full = await connect(apiKey);
    let fullNames: string[];
    try {
      fullNames = (await full.client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await full.close();
    }

    const { client, close } = await connect(apiKey, '?toolsets=prompts,traces&read-only=true');
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names.length).toBeGreaterThan(0);
      expect(names.length).toBeLessThan(fullNames.length);
      expect(names).toEqual(expect.arrayContaining(['list_prompts', 'search_traces']));
      // Read-only removes every mutating tool, and the toolset filter removes the rest.
      expect(names).not.toContain('create_prompt');
      expect(names).not.toContain('list_datasets');
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    } finally {
      await close();
    }
  });

  it('refuses a mutating call from a read-only connection, because the tool is not there', async () => {
    const { client, close } = await connect(apiKey, '?read-only=true');
    try {
      const result = (await client.callTool({
        name: 'create_prompt',
        arguments: { name: 'should-not-exist' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      // The reason must be that the tool is missing, not some other failure of a tool
      // that is still registered.
      expect((result.content[0] as { text: string }).text).toMatch(/create_prompt not found/);
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'create_prompt',
      );
      expect(await prisma.prompt.count({ where: { name: 'should-not-exist' } })).toBe(0);
    } finally {
      await close();
    }
  });

  it('rejects an unknown option value with a 400 naming the valid ones', async () => {
    const res = await request(server)
      .post('/api/v1/mcp?toolsets=prompts,nonsense')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('nonsense');
    expect(res.body.error.message).toContain('evaluations');
  });

  it('rejects base-url and api-key as query parameters', async () => {
    for (const query of ['?base-url=http://169.254.169.254', '?api-key=acx_sk_other']) {
      const res = await request(server)
        .post(`/api/v1/mcp${query}`)
        .set('Authorization', `Bearer ${apiKey}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(res.status).toBe(400);
    }
  });

  it('treats a bare ?read-only as read-only, like the bare --read-only flag', async () => {
    const { client, close } = await connect(apiKey, '?read-only');
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('list_prompts');
      expect(names).not.toContain('create_prompt');
      expect(names).not.toContain('promote_prompt_alias');
    } finally {
      await close();
    }
  });

  /**
   * Posts an `initialize` with the given query string and returns the response, for the
   * cases that must fail before any MCP traffic happens.
   */
  async function initializeWith(query: string): Promise<request.Response> {
    return request(server)
      .post(`/api/v1/mcp${query}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  }

  it('rejects a read-only value that is not a yes or no, instead of reading it as false', async () => {
    for (const query of ['?read-only=ture', '?read-only=maybe']) {
      const res = await initializeWith(query);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('read-only');
    }
  });

  it('rejects a repeated single-value option instead of joining it with commas', async () => {
    for (const query of ['?read-only=true&read-only=true', '?prompt-alias=a&prompt-alias=b']) {
      const res = await initializeWith(query);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('more than once');
    }
  });

  it('still joins a repeated toolsets parameter', async () => {
    const { client, close } = await connect(apiKey, '?toolsets=prompts&toolsets=traces');
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['list_prompts', 'search_traces']));
      expect(names).not.toContain('list_datasets');
    } finally {
      await close();
    }
  });

  it('caps timeout-ms and max-text-bytes on the hosted endpoint', async () => {
    for (const query of [
      '?timeout-ms=3000000000',
      '?timeout-ms=300001',
      '?max-text-bytes=1000001',
    ]) {
      const res = await initializeWith(query);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('at most');
    }
    const ok = await initializeWith('?timeout-ms=300000&max-text-bytes=1000000');
    expect(ok.status).toBe(200);
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
