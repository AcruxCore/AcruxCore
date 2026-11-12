import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

const RUNWARE = 'https://api.runware.ai/v1';
const KEY = 'rw-test-key-0000000000WX12';

/**
 * Runware's `/v1/models`, cut down from the live list (2026-11-13): per-token price strings,
 * one model without `pricing` (Runware lists 14 such), and one without a cache-read price.
 */
const MODELS_BODY = {
  object: 'list',
  data: [
    {
      id: 'minimax-m3',
      output_modalities: ['text'],
      pricing: { prompt: '0.0000003', completion: '0.0000012', image: '0', request: '0', input_cache_read: '0.00000006' },
    },
    { id: 'openai-gpt-5-5', output_modalities: ['text'] },
    { id: 'deepseek-v4-flash', output_modalities: ['text'], pricing: { prompt: '0.00000008', completion: '0.00000015' } },
    // More digits than the price columns (4 decimals) hold.
    { id: 'tiny-model', output_modalities: ['text'], pricing: { prompt: '0.00000001875', completion: '0.00000000001' } },
  ],
};

/** The usage Runware returned for a live zai-glm-5-3-flash call (2026-11-13). */
const USAGE = {
  prompt_tokens: 18,
  completion_tokens: 151,
  total_tokens: 169,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 142 },
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** Every request the fake Runware received. */
const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> | null }> = [];

/** Replies as Runware would; the reply to a chat call depends on `stream` and the model. */
function fakeRunware(url: string, init: RequestInit | undefined): Response {
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  calls.push({ url, auth: headers.get('authorization'), body });

  if (headers.get('authorization') !== `Bearer ${KEY}`) {
    return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 });
  }
  if (url === `${RUNWARE}/models`) return Response.json(MODELS_BODY);
  if (url !== `${RUNWARE}/chat/completions`) return new Response('{}', { status: 404 });

  if (body?.['model'] === 'broken') {
    return Response.json({ error: { message: 'Provider rejected the request', code: 500 } });
  }
  // Runware echoes its own AIR id, not the slug the caller sent.
  const air = 'minimax:m3@0';
  if (body?.['stream']) {
    const frames = [
      { id: 'chatcmpl-rw-1', object: 'chat.completion.chunk', model: air, choices: [{ index: 0, delta: { content: 'Hi ', reasoning_content: '.' } }], usage: null },
      { id: 'chatcmpl-rw-1', object: 'chat.completion.chunk', model: air, choices: [{ index: 0, delta: { content: 'there' }, finish_reason: 'stop' }], usage: null },
      { id: 'chatcmpl-rw-1', object: 'chat.completion.chunk', model: air, choices: [], usage: USAGE },
    ];
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + ': ping\n\ndata: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return Response.json({
    id: 'chatcmpl-rw-2',
    object: 'chat.completion',
    created: 1794511308,
    model: air,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' }],
    usage: USAGE,
  });
}

beforeEach(() => {
  calls.length = 0;
  const realFetch = global.fetch;
  // Only the paid provider is faked; any other fetch goes out as normal.
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(RUNWARE) ? fakeRunware(url, init) : realFetch(input, init);
  });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await prisma.$disconnect();
});

/** Signs up a team with a Runware connection and returns the agent and connection id. */
async function arrange(config: Record<string, unknown> = {}) {
  const { agent } = await authedAgent(app);
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'runware', label: 'Runware', apiKey: KEY, config })
    .expect(201);
  return { agent, credentialId: conn.body.id as string };
}

describe('Runware provider', () => {
  it('lists every Runware chat model with its prices, then serves and bills a call', async () => {
    const { agent, credentialId } = await arrange();

    const listed = await agent.get(`/api/v1/gateway/connections/${credentialId}/models`).expect(200);
    expect(listed.body).toEqual({
      ok: true,
      models: [
        { id: 'deepseek-v4-flash', pricing: { inputPricePerM: 0.08, outputPricePerM: 0.15 } },
        { id: 'minimax-m3', pricing: { inputPricePerM: 0.3, outputPricePerM: 1.2, cachedInputPricePerM: 0.06 } },
        { id: 'openai-gpt-5-5' },
        // Rounded to the 4 decimals the price columns store, so the form shows what is saved.
        { id: 'tiny-model', pricing: { inputPricePerM: 0.0188, outputPricePerM: 0 } },
      ],
    });
    expect(calls.at(-1)).toMatchObject({ url: `${RUNWARE}/models`, auth: `Bearer ${KEY}` });

    // The list only prefills the form: what is stored is what the caller sends.
    const model = await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'm3', upstreamModel: 'minimax-m3', credentialId, inputPricePerM: 0.3, outputPricePerM: 1.2 })
      .expect(201);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'm3', messages: [{ role: 'user', content: 'Say hi' }], max_tokens: 300 })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('Hi there');
    const sent = calls.at(-1)!;
    expect(sent.url).toBe(`${RUNWARE}/chat/completions`);
    // max_completion_tokens: Runware refuses max_tokens for its OpenAI reasoning models
    // (openai-gpt-5-5 answers 400 "Unsupported parameter"), and every other model takes it.
    expect(sent.body).toMatchObject({ model: 'minimax-m3', max_completion_tokens: 300, stream: false });
    expect(sent.body).not.toHaveProperty('max_tokens');

    const expected = (18 * 0.3 + 151 * 1.2) / 1e6;
    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo(expected, 12);
    const row = await prisma.gatewayRequest.findUniqueOrThrow({ where: { id: res.headers['x-gateway-request-id'] } });
    expect(row.provider).toBe('runware');
    expect(row.gatewayModelId).toBe(model.body.id);
    expect(row.costUsd?.toNumber()).toBeCloseTo(expected, 9);
  });

  it('streams a call and bills it from the usage chunk', async () => {
    const { agent, credentialId } = await arrange();
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'm3', upstreamModel: 'minimax-m3', credentialId, inputPricePerM: 0.3, outputPricePerM: 1.2 })
      .expect(201);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'm3', messages: [{ role: 'user', content: 'Say hi' }], stream: true })
      .buffer(true)
      .parse((r, done) => {
        let text = '';
        r.on('data', (c: Buffer) => (text += c.toString()));
        r.on('end', () => done(null, text));
      })
      .expect(200);

    const content = (res.body as string)
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> })
      .map((f) => f.choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(content).toBe('Hi there');
    expect(calls.at(-1)!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });

    // The row is written once the stream ends.
    const expected = (18 * 0.3 + 151 * 1.2) / 1e6;
    let row = null;
    for (let i = 0; i < 50 && !row?.costUsd; i++) {
      row = await prisma.gatewayRequest.findFirst({ where: { providerConnectionId: credentialId }, orderBy: { createdAt: 'desc' } });
      if (!row?.costUsd) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row?.provider).toBe('runware');
    expect(row?.costUsd?.toNumber()).toBeCloseTo(expected, 9);
  });

  it('always calls Runware, whatever base_url the connection stores', async () => {
    const { agent, credentialId } = await arrange({ base_url: 'https://attacker.example.com/v1' });
    await agent.post('/api/v1/gateway/models').send({ publicName: 'm3', upstreamModel: 'minimax-m3', credentialId }).expect(201);

    await agent.get(`/api/v1/gateway/connections/${credentialId}/models`).expect(200);
    await agent.post('/api/v1/gateway/chat/completions').send({ model: 'm3', messages: [{ role: 'user', content: 'hi' }] }).expect(200);

    expect(calls.map((c) => c.url)).toEqual([`${RUNWARE}/models`, `${RUNWARE}/chat/completions`]);
  });

  it('refuses extra headers on a Runware connection', async () => {
    const { agent } = await authedAgent(app);
    await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'runware', label: 'Runware', apiKey: KEY, config: { headers: { 'x-a': 'b' } } })
      .expect(400);
  });

  it('sends a Claude prompt-cache marker inside a content block', async () => {
    const { agent, credentialId } = await arrange();
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'haiku', upstreamModel: 'anthropic-claude-haiku-4-5', credentialId })
      .expect(201);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'haiku',
        messages: [
          { role: 'system', content: 'You are terse.', cache_control: { type: 'ephemeral' } },
          { role: 'user', content: 'hi' },
        ],
      })
      .expect(200);

    const messages = calls.at(-1)!.body!['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('names Runware in the error when Runware refuses the key', async () => {
    const { agent } = await authedAgent(app);
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'runware', label: 'Runware', apiKey: 'rw-wrong-key-000000000ZZ99' })
      .expect(201);

    const listed = await agent.get(`/api/v1/gateway/connections/${conn.body.id}/models`).expect(200);
    expect(listed.body.ok).toBe(false);
    expect(listed.body.error).toContain('Runware refused the model list (HTTP 401)');

    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'm3', upstreamModel: 'minimax-m3', credentialId: conn.body.id })
      .expect(201);
    const res = await agent.post('/api/v1/gateway/chat/completions').send({ model: 'm3', messages: [{ role: 'user', content: 'hi' }] });
    // 409, not 401: the gateway's own key was fine; the stored Runware key was refused.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROVIDER_AUTH_FAILED');
    expect(res.body.error.message).toContain('Runware request failed with status 401');
  });

  it('names Runware when Runware answers 200 with an error and no completion', async () => {
    const { agent, credentialId } = await arrange();
    await agent.post('/api/v1/gateway/models').send({ publicName: 'b', upstreamModel: 'broken', credentialId }).expect(201);
    const res = await agent.post('/api/v1/gateway/chat/completions').send({ model: 'b', messages: [{ role: 'user', content: 'hi' }] });
    // 503: a 5xx from the only upstream leaves nothing to fall back to.
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('Runware request failed');
    expect(res.body.error.message).not.toContain('OpenAI');
  });
});
