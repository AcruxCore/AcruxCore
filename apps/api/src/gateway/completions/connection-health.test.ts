process.env.GATEWAY_ENCRYPTION_KEY =
  process.env.GATEWAY_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authHeaders, resetAuthTables, signupTestUser, type TestAuthContext } from '../../test-utils';

/**
 * A connection the gateway cannot call at all is a fault in the team's own
 * configuration, and a working fallback hides it completely: the call returns a
 * normal 200, the dashboard is green, and every request goes to the fallback at
 * the fallback's prices for as long as nobody notices. The span records a
 * `model_fallback` warning, but that is what an upstream having a bad minute
 * looks like too, and nobody reads the trace of a call that worked.
 *
 * So the team is told once per connection per day. These tests drive the real
 * gateway: the primary's `base_url` is a hostname that cannot resolve, which the
 * request-time guard refuses exactly as it refuses a private address, and the
 * fallback is an ordinary OpenAI connection whose outbound call is the one thing
 * a test here may stand in for.
 */

const app = createApp();

/** Canned OpenAI-shaped success body for the connection that does work. */
const OK_BODY = {
  id: 'chatcmpl-health',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

/** OpenAI streaming frames that spell "Hello" and then finish. */
const SSE_FRAMES = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

/** A streaming Response whose body emits {@link SSE_FRAMES}. */
function sseResponse(): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of SSE_FRAMES) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Stands in for the provider the *fallback* connection points at — the one
 * allowed exception to real-data-only, an outbound call to a paid third party.
 * The blocked connection never reaches this: it is refused before a socket is
 * opened, on a different code path (`undici`, not `fetch`).
 */
function mockWorkingProvider(): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(OK_BODY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

/**
 * Creates a connection whose base URL is a hostname that is guaranteed never to
 * resolve (RFC 6761 reserves `.invalid`). It saves, because the schema check
 * cannot resolve a hostname, and is refused at request time — the same
 * `SSRF_BLOCKED` a private address produces.
 *
 * @param ctx - Signed-in team.
 * @param label - The connection's name, which the email must quote.
 * @returns The connection id.
 */
async function createUnreachableConnection(ctx: TestAuthContext, label: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/gateway/connections')
    .set(authHeaders(ctx))
    .send({
      provider: 'openai_compatible',
      label,
      apiKey: 'sk-not-a-real-key',
      config: { base_url: `http://${label}.invalid/v1` },
    })
    .expect(201);
  return res.body.id;
}

async function createWorkingConnection(ctx: TestAuthContext, label: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/gateway/connections')
    .set(authHeaders(ctx))
    .send({ provider: 'openai', label, apiKey: `sk-${label}` })
    .expect(201);
  return res.body.id;
}

async function registerModel(
  ctx: TestAuthContext,
  publicName: string,
  credentialId: string,
  fallbackModelIds: string[] = [],
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/gateway/models')
    .set(authHeaders(ctx))
    .send({ publicName, upstreamModel: 'gpt-4o-mini', credentialId, fallbackModelIds })
    .expect(201);
  return res.body.id;
}

function complete(ctx: TestAuthContext, body: Record<string, unknown>) {
  return request(app).post('/api/v1/gateway/chat/completions').set(authHeaders(ctx)).send(body);
}

/** Every connection-health notice queued for a team, oldest first. */
async function healthEmails(teamId: string) {
  return prisma.emailLog.findMany({
    where: { teamId, type: 'connection_blocked' },
    orderBy: { createdAt: 'asc' },
  });
}

let restoreFetch: jest.SpyInstance;

beforeEach(async () => {
  await resetAuthTables();
  restoreFetch = mockWorkingProvider();
});

afterEach(() => {
  restoreFetch.mockRestore();
});

afterAll(async () => {
  await resetAuthTables();
  await prisma.$disconnect();
});

describe('a connection the gateway cannot call is reported, even when the call succeeds', () => {
  it('notifies once when a fallback answers for an unreachable primary', async () => {
    const ctx = await signupTestUser(app);
    const dead = await createUnreachableConnection(ctx, 'dead-primary');
    const alive = await createWorkingConnection(ctx, 'live-fallback');

    const fallbackModel = await registerModel(ctx, 'health-fallback', alive);
    await registerModel(ctx, 'health-primary', dead, [fallbackModel]);

    const res = await complete(ctx, {
      model: 'health-primary',
      messages: [{ role: 'user', content: 'hello' }],
    });

    // The point of the whole thing: from the caller's side nothing went wrong.
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Hi');

    // And the trail says why, which is what the notice is built from.
    const row = await prisma.gatewayRequest.findFirst({
      where: { teamId: ctx.teamId },
      orderBy: { createdAt: 'desc' },
    });
    const trail = (row?.meta as { trail?: { blockedAddress?: boolean }[] })?.trail ?? [];
    expect(trail.some((entry) => entry.blockedAddress === true)).toBe(true);

    const emails = await healthEmails(ctx.teamId);
    expect(emails).toHaveLength(1);
    // Names the connection. A notice that says only "a connection is
    // unreachable" sends the reader hunting through a list.
    expect(emails[0].subject).toContain('dead-primary');
  });

  it('says it once however many calls hit the same connection', async () => {
    const ctx = await signupTestUser(app);
    const dead = await createUnreachableConnection(ctx, 'noisy-primary');
    const alive = await createWorkingConnection(ctx, 'noisy-fallback');
    const fallbackModel = await registerModel(ctx, 'noisy-fallback-model', alive);
    await registerModel(ctx, 'noisy-primary-model', dead, [fallbackModel]);

    for (let i = 0; i < 3; i++) {
      await complete(ctx, {
        model: 'noisy-primary-model',
        messages: [{ role: 'user', content: `call ${i}` }],
      }).expect(200);
    }

    // Three calls, one email. A team running a thousand an hour against a dead
    // primary must not be mailed a thousand times.
    expect(await healthEmails(ctx.teamId)).toHaveLength(1);
  });

  it('notifies when nothing answered either, and still refuses with the address code', async () => {
    const ctx = await signupTestUser(app);
    const dead = await createUnreachableConnection(ctx, 'only-primary');
    await registerModel(ctx, 'lonely-primary', dead);

    const res = await complete(ctx, {
      model: 'lonely-primary',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_ADDRESS_BLOCKED');

    const emails = await healthEmails(ctx.teamId);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain('only-primary');
  });

  it('notifies on the streaming path, which hides it exactly as well', async () => {
    restoreFetch.mockRestore();
    restoreFetch = jest.spyOn(global, 'fetch').mockImplementation(async () => sseResponse());

    const ctx = await signupTestUser(app);
    const dead = await createUnreachableConnection(ctx, 'streamed-primary');
    const alive = await createWorkingConnection(ctx, 'streamed-fallback');
    const fallbackModel = await registerModel(ctx, 'streamed-fallback-model', alive);
    await registerModel(ctx, 'streamed-primary-model', dead, [fallbackModel]);

    const res = await complete(ctx, {
      model: 'streamed-primary-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    }).expect(200);

    // The stream really did carry an answer, so nothing about the call looked wrong.
    expect(res.text).toContain('[DONE]');
    expect(res.text).toContain('lo');

    const emails = await healthEmails(ctx.teamId);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain('streamed-primary');
  });

  it('reports the unreachable connection, not the last thing the chain said', async () => {
    // A streamed chain whose primary is unreachable and whose fallback answers
    // 401. Both fail, so the caller gets an error either way — the question is
    // which one. The 401 is the provider's, and the team cannot act on it; the
    // unreachable base URL is theirs, and they can. `callWithFallback` already
    // preferred it on the blocking path; the streaming loop kept whatever came
    // last, which was always the fallback's.
    restoreFetch.mockRestore();
    restoreFetch = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const ctx = await signupTestUser(app);
    const dead = await createUnreachableConnection(ctx, 'buried-primary');
    const badKey = await createWorkingConnection(ctx, 'bad-key-fallback');
    const fallbackModel = await registerModel(ctx, 'buried-fallback-model', badKey);
    await registerModel(ctx, 'buried-primary-model', dead, [fallbackModel]);

    const res = await complete(ctx, {
      model: 'buried-primary-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_ADDRESS_BLOCKED');
  });
});
