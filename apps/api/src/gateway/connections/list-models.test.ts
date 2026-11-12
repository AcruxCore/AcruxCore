import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const app = createApp();

/** Requests the fake provider received, by path, so a test can tell a cache hit from a fetch. */
const hits: Record<string, number> = {};
/** Authorization / x-goog-api-key headers the fake provider saw, newest last. */
const seenKeys: string[] = [];

let server: http.Server;
let origin: string;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    hits[path] = (hits[path] ?? 0) + 1;
    seenKeys.push(String(req.headers['authorization'] ?? req.headers['x-goog-api-key'] ?? ''));
    res.setHeader('Content-Type', 'application/json');

    if (path === '/compat/v1/models') {
      // Unsorted and with a duplicate, to prove the endpoint sorts and de-duplicates.
      // OpenRouter-style, with per-token prices: the endpoint passes them on per 1M tokens.
      // The router entry's -1 means "depends on the model it picks", so it has no price.
      res.end(
        JSON.stringify({
          data: [
            { id: 'openai/gpt-4o-mini', pricing: { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000075' } },
            { id: 'anthropic/claude-x' },
            { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
            { id: 'openai/gpt-4o-mini', pricing: { prompt: '9', completion: '9' } },
          ],
        }),
      );
      return;
    }
    if (path === '/oai/v1/models') {
      res.end(
        JSON.stringify({
          data: [
            { id: 'gpt-4o' },
            { id: 'text-embedding-3-small' },
            { id: 'tts-1' },
            { id: 'gpt-9-unlisted' },
            { id: 'gpt-4o-mini' },
            { id: 'dall-e-3' },
          ],
        }),
      );
      return;
    }
    if (path === '/gem/v1beta/models') {
      res.end(
        JSON.stringify({
          models: [
            { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
      );
      return;
    }
    if (path === '/denied/v1/models') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetSsrfAllowlist();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** Creates a connection through the API and returns its id. */
async function connect(
  agent: Awaited<ReturnType<typeof authedAgent>>['agent'],
  provider: string,
  baseUrl: string,
  apiKey = 'sk-test-00000000000AB12',
): Promise<string> {
  const res = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider, label: `${provider}-${baseUrl}`, apiKey, config: { base_url: baseUrl } })
    .expect(201);
  return res.body.id as string;
}

describe('GET /api/v1/gateway/connections/:id/models', () => {
  it('lists the provider models sorted and unique, caches them, and refetches after a key rotation', async () => {
    const { agent } = await authedAgent(app);
    const id = await connect(agent, 'openai_compatible', `${origin}/compat/v1`, 'sk-test-first-key-AB12');
    const before = hits['/compat/v1/models'] ?? 0;

    const first = await agent.get(`/api/v1/gateway/connections/${id}/models`).expect(200);
    // The first entry wins a duplicate id. Prices are read only from OpenRouter's own host,
    // whose unit (USD per token) is known: another host could state per-1M prices under the
    // same names, and they would be copied a million times too high.
    expect(first.body).toEqual({
      ok: true,
      models: [{ id: 'anthropic/claude-x' }, { id: 'openai/gpt-4o-mini' }, { id: 'openrouter/auto' }],
    });
    expect(seenKeys.at(-1)).toBe('Bearer sk-test-first-key-AB12');
    expect(hits['/compat/v1/models']).toBe(before + 1);

    // Second read is served from the cache: the provider is not called again.
    await agent.get(`/api/v1/gateway/connections/${id}/models`).expect(200);
    expect(hits['/compat/v1/models']).toBe(before + 1);

    // Rotating the key changes the connection's version, so the next read fetches with the new key.
    await agent.patch(`/api/v1/gateway/connections/${id}`).send({ apiKey: 'sk-test-second-key-CD34' }).expect(200);
    await agent.get(`/api/v1/gateway/connections/${id}/models`).expect(200);
    expect(hits['/compat/v1/models']).toBe(before + 2);
    expect(seenKeys.at(-1)).toBe('Bearer sk-test-second-key-CD34');
  });

  it('filters non-chat models and lists ids only, with no prices, for direct providers', async () => {
    const { agent } = await authedAgent(app);
    const openai = await connect(agent, 'openai', `${origin}/oai/v1`);
    const gemini = await connect(agent, 'gemini', `${origin}/gem/v1beta`);

    const o = await agent.get(`/api/v1/gateway/connections/${openai}/models`).expect(200);
    // gpt-4o is in the price registry, and its prices are still not attached.
    expect(o.body).toEqual({ ok: true, models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-9-unlisted' }] });

    const g = await agent.get(`/api/v1/gateway/connections/${gemini}/models`).expect(200);
    expect(g.body).toEqual({ ok: true, models: [{ id: 'gemini-2.0-flash' }] });
  });

  it('reports a provider refusal in the body and does not cache it', async () => {
    const { agent } = await authedAgent(app);
    const id = await connect(agent, 'openai_compatible', `${origin}/denied/v1`);
    const before = hits['/denied/v1/models'] ?? 0;

    const res = await agent.get(`/api/v1/gateway/connections/${id}/models`).expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('HTTP 401');
    expect(res.body.models).toBeUndefined();

    await agent.get(`/api/v1/gateway/connections/${id}/models`).expect(200);
    expect(hits['/denied/v1/models']).toBe(before + 2);
  });

  it("returns 404 for another team's connection", async () => {
    const owner = await authedAgent(app);
    const id = await connect(owner.agent, 'openai_compatible', `${origin}/compat/v1`);
    const other = await authedAgent(app);
    await other.agent.get(`/api/v1/gateway/connections/${id}/models`).expect(404);
  });
});
